// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://151ddd2738c745829afbed143c7b5ef0:10f0842a61c94f6cbc542de579104e86@sentry.cozycloud.cc/24'

const moment = require('moment')
moment.locale('fr')

const {
  log,
  BaseKonnector,
  requestFactory,
  utils,
  cozyClient,
  manifest
} = require('cozy-konnector-libs')
const { Q } = require('cozy-client')

// Importing models to get qualification by label
const models = cozyClient.new.models
const { Qualification } = models.document

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

  const lines = await extractLines($accountPage)
  let bills = []
  if (lines.length < 1) {
    log('info', `Found 1 lines in total`)
    bills = await parseBills($accountPage)
  } else {
    log('info', `Found ${lines.length} lines in total`)
    for (const line of lines) {
      log('info', `Extract line number ${lines.indexOf(line)}`)
      // Switch account
      const $otherPage = await request({ uri: `${baseUrl}/account/${line[1]}` })
      // Parsing bills
      bills = bills.concat(await parseBills($otherPage, line[0]))
    }
  }

  await this.saveBills(bills, fields.folderPath, {
    fileIdAttributes: ['vendor', 'contractId', 'date', 'amount'],
    linkBankOperations: false,
    identifiers: 'free mobile',
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
  })
  // Following changes on the targeted website after the 1.11.0 release, we need to clean unwanted directories
  await cleaningUnwantedElements()
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
    if ($(value).attr('href').includes('/account/?logout')) {
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

function extractLines($) {
  const liList = Array.from($('li.user'))
  // Construct link array
  const lines = []
  for (const line of liList) {
    lines.push([
      // Phone Number
      $(line)
        .text()
        .match(/0\d \d{2} \d{2} \d{2} \d{2}/)[0]
        .replace(/ /g, ''),
      // Account link
      $(line).find('a').attr('href')
    ])
  }
  return lines
}

// Parse the account page to extract bill data.
function parseBills($, secondaryLinePhoneNumber) {
  const bills = []
  const titulaire = $('div.identite').text().trim()
  let phoneNumber = secondaryLinePhoneNumber
    ? secondaryLinePhoneNumber
    : $('p.table-sub-title').text().trim().replace(/ /g, '')
  const tabLines = Array.from($('div.table-facture').find('div.grid-l'))

  for (let line of tabLines) {
    const amount = parseFloat(
      $(line).find('div.amount').text().trim().replace('€', '')
    )

    const url = $(line).find('div.download > a').attr('href')
    const type = url.match(/facture=([a-z]*)/)[1]
    let date
    if (type == 'pdf') {
      date = moment(url.match(/date=([0-9]{8})/)[1], 'YYYYMMDD')
    } else if (type == 'pdfrecap') {
      // When bills is Multiline, the date in url is always the date of the day
      // So we extract the date from the line of the array of bills

      const dateString = $(line).find('div.date').text().trim()
      date = moment(dateString, 'MMMM YYYY')
    } else {
      log('warn', 'Impossible to match a date for this bill')
      continue
    }
    const contractId = url.match(/&l=([0-9]*)/)[1]
    const invoiceId = url.match(/&id=([0-9abcdef]*)/)[1]
    const bill = {
      amount,
      currency: 'EUR',
      fileurl: baseUrl + url,
      filename: `${date.format('YYYYMM')}_freemobile_${amount.toFixed(2)}€.pdf`,
      date: date.utc().toDate(),
      contractId: type == 'pdfrecap' ? 'Multiligne' : phoneNumber,
      contractLabel: `${
        type == 'pdfrecap' ? 'Multiligne' : phoneNumber
      } (${titulaire})`,
      vendor: 'Free Mobile',
      type: 'phone',
      recurrence: 'monthly',
      fileAttributes: {
        metadata: {
          datetime: date.utc().toDate(),
          datetimeLabel: 'issueDate',
          contentAuthor: 'free',
          issueDate: date.utc().toDate(),
          invoiceNumberV2: invoiceId,
          contractReference: contractId,
          isSubscription: true,
          carbonCopy: true,
          qualification: Qualification.getByLabel('phone_invoice')
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

async function cleaningUnwantedElements() {
  const months = [
    'janvier',
    'février',
    'mars',
    'avril',
    'mai',
    'juin',
    'juillet',
    'août',
    'septembre',
    'octobre',
    'novembre',
    'décembre'
  ]
  const dirsToDelete = []
  const filesInDirsToDelete = []
  const filesToDelete = []
  const dirsQuery = Q('io.cozy.files')
    .where({
      'cozyMetadata.createdByApp': manifest.data.slug
    })
    .partialIndex({
      // This option is to make sure the request just retrieve never-trashed directories
      restore_path: { $exists: false },
      type: 'directory'
    })
  const dirsResults = await cozyClient.new.queryAll(dirsQuery)
  for (const result of dirsResults) {
    if (months.some(month => result.attributes.name.startsWith(month))) {
      dirsToDelete.push(result.id)
    }
  }
  for (const directoryId of dirsToDelete) {
    const filesQuery = Q('io.cozy.files')
      .where({
        dir_id: directoryId
      })
      .partialIndex({
        trashed: false,
        type: 'file'
      })
    const filesResults = await cozyClient.new.queryAll(filesQuery)
    for (const file of filesResults) {
      filesInDirsToDelete.push(file)
    }
  }
  for (const file of filesInDirsToDelete) {
    // Making sure we're not deleting any file wich might have been created by the user
    if (file.cozyMetadata.createdByApp === manifest.data.slug) {
      filesToDelete.push(file._id)
    } else {
      // If some are found, get rid of the id of the dir. they come from in 'dirsToDelete' list
      // so the user can keep them.
      const idx = dirsToDelete.indexOf(file.dir_id)
      // If there is more than one file created by the user in the checked dir, next loop will find '-1'
      // so we're avoiding the '.splice' method as the dir is already erased from the list
      if (idx === -1) {
        continue
      }
      dirsToDelete.splice(idx, 1)
    }
  }
  const elementsToDelete = filesToDelete.concat(dirsToDelete)
  await Promise.all(
    elementsToDelete.map(elementToDelete =>
      cozyClient.new
        .collection('io.cozy.files')
        .deleteFilePermanently(elementToDelete)
    )
  )
}
