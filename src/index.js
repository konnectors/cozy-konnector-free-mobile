// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://151ddd2738c745829afbed143c7b5ef0:10f0842a61c94f6cbc542de579104e86@sentry.cozycloud.cc/24'

const moment = require('moment')

const { log, BaseKonnector, requestFactory, utils, cozyClient } = require('cozy-konnector-libs')

let request = requestFactory({
  cheerio: true,
  json: false,
  // debug: true,
  jar: true
})

const baseUrl = 'https://mobile.free.fr'

module.exports = new BaseKonnector(async function fetch(fields) {
  await this.deactivateAutoSuccessfulLogin()
  const $accountPage = await login(fields)
  await this.notifySuccessfulLogin()
  // Evaluating clientName
  const clientName = extractClientName($accountPage)
  // As login need to be successfull to reach this point, login is a valid data
  const accountDirectoryLabel = `${clientName} (${fields.login})`

  // Disable this function to get a degraded standalone mode working
  // (not in cozy-client-js-stub)
  this._account = await ensureAccountDirectoryLabel(
    this._account,
    fields,
    accountDirectoryLabel
  )

  const otherLines = await extractOtherLines($accountPage)
  log('info', `Found ${1 + otherLines.length} lines in total`)
  log('info', 'Extract bills from main line')
  let bills = await parseBills($accountPage)
  for (const line of otherLines) {
    log('info', `Extract additionnal line`)
    // Switch account
    const $otherPage = await request({ uri: `${baseUrl}/account/${line}` })
    // Parsing bills
    bills = bills.concat(await parseBills($otherPage))
  }

  await this.saveBills(bills, fields.folderPath, {
    fileIdAttributes: ['vendor', 'contractId', 'date', 'amount'],
    linkBankOperations: false,
    identifiers: 'free mobile',
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
  })
})

async function login(fields) {
  if (!fields.login.match(/^\d+$/)) {
    log('error', 'detected not numerical chars')
    throw new Error('LOGIN_FAILED.WRONG_LOGIN_FORM')
  }
  // Prefetching cookie
  await request(`${baseUrl}/account/`)
  // Login with POST
  const $req = await request({
    uri: `${baseUrl}/account/`,
    method: 'POST',
    form: {
      'login-ident': fields.login,
      'login-pwd': fields.password,
      'bt-login': 1
    }
  })
  // No difference found on request, so we detect login in html content
  if (hasLogoutButton($req)) {
    // Login button is a type a with a specific href
    return $req
  } else if ($req.html().includes('utilisateur ou mot de passe incorrect')) {
    // Only display an error message in a div so we look for it
    throw new Error('LOGIN_FAILED')
  } else {
    throw new Error('VENDOR_DOWN')
  }
}

function hasLogoutButton($) {
  let status = false
  $('a').each((index, value) => {
    if (
      $(value)
        .attr('href')
        .includes('/account/?logout')
    ) {
      status = true
    }
  })
  return status
}

function extractClientName($page) {
  // Something like '   "     Jean Valjean    "  '
  const raw = $page('.identite').text()
  return raw.replace('"', '').trim()
}

function extractOtherLines($) {
  const liList = Array.from($('li.user'))
  // Remove line already prompted
  liList.shift()
  // Construct link array
  const otherLines = []
  for (const line of liList) {
    otherLines.push(
      $(line)
        .find('a')
        .attr('href')
    )
  }
  return otherLines
}

// Parse the account page to extract bill data.
function parseBills($) {
  const bills = []
  const titulaire = $('div.identite')
    .text()
    .trim()
  const tabLines = Array.from($('div.table-facture').find('div.grid-l'))
  for (let line of tabLines) {
    const amount = parseFloat(
      $(line)
        .find('div.amount')
        .text()
        .trim()
        .replace('€', '')
    )
    const url = $(line)
      .find('div.download > a')
      .attr('href')
    const date = moment(url.match(/&date=([0-9]{8})/)[1], 'YYYYMMDD')
    const contractId = url.match(/&l=([0-9]*)/)[1]
    const invoiceId = url.match(/&id=([0-9abcdef]*)/)[1]
    const phoneNumber = $(line)
      .find('div.date')
      .text()
      .trim()
      .split('-')[0]
      .replace(/ /g, '')
    const bill = {
      amount,
      currency: 'EUR',
      fileurl: baseUrl + url,
      filename: `${date.format('YYYYMM')}_freemobile_${amount.toFixed(2)}€.pdf`,
      date: date.toDate(),
      contractId: phoneNumber,
      contractLabel: `${phoneNumber} (${titulaire})`,
      vendor: 'Free Mobile',
      type: 'phone',
      recurrence: 'monthly',
      fileAttributes: {
        metadata: {
          classification: 'invoicing',
          datetime: date.toDate(),
          datetimeLabel: 'issueDate',
          contentAuthor: 'free',
          subClassification: 'invoice',
          categories: ['phone'],
          issueDate: date.toDate(),
          invoiceNumberV2: invoiceId,
          contractReference: contractId,
          isSubscription: true
        }
      }
    }
    bills.push(bill)
  }
  return bills
}

async function renameDir(fields, label) {
  return await cozyClient.files.updateAttributesByPath(fields.folderPath, {
    name: label
  })
}

async function ensureAccountDirectoryLabel(account, fields, label) {
  const needLabel = !account || !account.label
  if (needLabel) {
    log('info', `Renaming the folder to ${label}`)
    try {
      const newFolder = await renameDir(fields, label)
      fields.folderPath = newFolder.attributes.path
    } catch (e) {
      if (e.status === 409) {
        // We encounter a conflict when renaming a newly created directory (account re creation)
        log(
          'info',
          'Conflict detected, moving file in new dir and deleting the old one'
        )
        await moveOldFilesToNewDir(fields, label)
        // Try renaming a second time
        await renameDir(fields, label)
        // Path is already correct in a case of conflict
      } else {
        throw e
      }
    }

    log('info', `Updating the folder path in the account`)
    const newAccount = await cozyClient.data.updateAttributes(
      'io.cozy.accounts',
      account._id,
      {
        label,
        auth: {
          ...account.auth,
          folderPath: fields.folderPath,
          namePath: label
        }
      }
    )
    return newAccount
  } else {
    return account
  }
}

async function moveOldFilesToNewDir(fields, label) {
  const pathConflicting =
    fields.folderPath.slice(0, fields.folderPath.lastIndexOf('/')) + '/' + label
  const dirToDelete = await cozyClient.files.statByPath(pathConflicting)
  const dirToKeep = await cozyClient.files.statByPath(fields.folderPath)
  const filesToMove = await utils.queryAll('io.cozy.files', {
    dir_id: dirToDelete._id
  })
  log('debug', `Moving ${filesToMove.length} files to ${dirToKeep._id}`)
  for (const file of filesToMove) {
    await cozyClient.files.updateAttributesById(file._id, {
      dir_id: dirToKeep._id
    })
  }
  log('debug', `Deleting old dir with id : ${dirToDelete._id}`)
  await cozyClient.files.destroyById(dirToDelete._id)
}
