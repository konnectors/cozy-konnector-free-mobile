// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://bda9bc980b114b06a11cde574155a466@errors.cozycloud.cc/57'

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
let requestJSON = requestFactory({
  cheerio: false,
  json: true,
  // debug: true,
  jar: true
})

const baseUrl = 'https://mobile.free.fr'
const linesAndNames = []

module.exports = new BaseKonnector(async function fetch(fields) {
  // 2FA is mandatory now, even with persisting cookie
  // We exit in case of auto exec
  if (process.env.COZY_JOB_MANUAL_EXECUTION !== 'true') {
    log('warn', "Not a manual execution, don't launch because 2FA needed")
    throw new Error('USER_ACTION_NEEDED.TWOFA_EXPIRED')
  }

  await this.deactivateAutoSuccessfulLogin()
  const $accountPage = await login.bind(this)(fields)
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

  // Construct an array with [phoneNumber, partialLinkToAccount] for each line
  // Link will be null for account with only one line
  const lines = await extractLines($accountPage)

  let bills = []
  if (lines.length === 0) {
    log('warn', 'No lines found on the website')
  } else if (lines.length === 1) {
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
    sourceAccountIdentifier: fields.login,
    verboseFileslog: true
  })
  // Following changes on the targeted website after the 1.15.0 release, we need to clean unwanted
  await cleaningUnwantedElements()
})

async function login(fields) {
  if (!fields.login.match(/^\d+$/)) {
    log('error', 'detected not numerical chars')
    throw new Error('LOGIN_FAILED.WRONG_LOGIN_FORM')
  }
  // Prefetching cookies
  await request(`${baseUrl}/account/v2/login/`)
  // Prefetching CSRF
  const $csrf = await requestJSON(`${baseUrl}/account/v2/api/auth/csrf`)
  const csrf = $csrf.csrfToken
  // Posting credentials
  try {
    await request({
      uri: `${baseUrl}/account/v2/api/auth/callback/credentials`,
      method: 'POST',
      form: {
        username: fields.login,
        password: fields.password,
        redirect: 'false',
        csrfToken: csrf,
        callbackUrl: 'https://mobile.free.fr/account/v2/login',
        json: 'true'
      }
    })
  } catch (e) {
    if (e.statusCode === 401) {
      log('error', e.error)
      throw new Error('LOGIN_FAILED')
    } else {
      log('error', e)
      log('error', 'Unknown error when sending credentials')
      throw new Error('VENDOR_DOWN')
    }
  }

  // Doing 2FA with possibly 3 try, account seems to block at 5
  const initialTryNumber = 1
  await waitFor2FA.bind(this)(initialTryNumber, csrf)

  // Control login via logout button
  const $mainPage = await request(`${baseUrl}/account/conso-et-factures`)
  if (hasLogoutButton($mainPage)) {
    return $mainPage
  } else {
    log(
      'error',
      'Not logout button after correct login, probably not connected'
    )
    throw new Error('VENDOR_DOWN')
  }
}

async function waitFor2FA(tryNumber, csrf) {
  const code2FA = await this.waitForTwoFaCode({
    type: 'sms'
  })
  try {
    await request({
      uri: `${baseUrl}/account/v2/api/auth/callback/credentials`,
      method: 'POST',
      form: {
        codeOtp: code2FA,
        redirect: 'false',
        csrfToken: csrf,
        callbackUrl: 'https://mobile.free.fr/account/v2/otp',
        json: 'true'
      }
    })
  } catch (e) {
    if (e.statusCode === 401) {
      log('error', 'Wrong 2FA Code')
      if (tryNumber < 3) {
        await waitFor2FA.bind(this)(tryNumber + 1, csrf)
      } else {
        log('error', e.error)
        throw new Error('LOGIN_FAILED.WRONG_TWOFA_CODE')
      }
    } else {
      log('error', e)
      log('error', 'Unknown error when sending 2FA code')
      throw new Error('VENDOR_DOWN')
    }
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
  const raw = $page('.identite_bis').text()
  const name = raw.replace('"', '').trim()
  if (name.length < 1) {
    log('error', 'No client name detected')
    throw new Error('UNKOWN_ERROR')
  }
  return name
}

function extractLines($) {
  const lines = []
  // Multi line selector is absent when mono line
  if ($('#multi-ligne-selector').length === 0) {
    // No adherence on the div with the phone number, get an upper div
    const number = $('.current-user__infos')
      .text()
      .match(/0\d \d{2} \d{2} \d{2} \d{2}/)[0]
      .replace(/ /g, '')
    lines.push([number, null])
  } else {
    const liList = Array.from($('li.user'))
    // Construct link array
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
  }
  return lines
}

// Parse the account page to extract bill data.
function parseBills($, secondaryLinePhoneNumber) {
  const bills = []
  const titulaire = $('div.identite_bis').text().trim()
  let phoneNumber = secondaryLinePhoneNumber
    ? secondaryLinePhoneNumber
    : $('p.table-sub-title').text().trim().replace(/ /g, '')
  // Saving name and number for cleaning purpose
  linesAndNames.push([phoneNumber, titulaire])
  const tabLines = Array.from($('div.table-facture').find('.invoice'))
  for (let line of tabLines) {
    const amount = parseFloat(
      $(line).find('div.table-price').text().trim().replace('€', '')
    )

    const url = $(line).find('div > a').attr('href')
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
      fileurl: baseUrl + '/account/conso-et-factures' + url,
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
  const dirsQuery = Q('io.cozy.files')
    .where({
      'cozyMetadata.createdByApp': manifest.data.slug
    })
    .partialIndex({
      // This option is to make sure the request just retrieve never-trashed directories
      restore_path: { $exists: false },
      type: 'directory'
    })
    .indexFields(['cozyMetadata.createdByApp'])
  const dirsResults = await cozyClient.new.queryAll(dirsQuery)
  for (const [phone, titulaire] of linesAndNames) {
    const brokenName = `${phone} ()`
    const correctName = `${phone} (${titulaire})`
    for (const dir of dirsResults) {
      // Checking existence of destination directory
      const correctDir = dirsResults.find(
        currentDir => currentDir.name === correctName
      )
      if (dir.name === brokenName && correctDir) {
        log('debug', 'Need to clean one directory')
        const idDestination = correctDir.id
        await movingFiles(dir.id, idDestination)
        await deletingDirIfEmpty(dir.id)
      }
    }
  }
}

async function movingFiles(idOrigine, idDestination) {
  const filesQuery = Q('io.cozy.files')
    .where({
      dir_id: idOrigine
    })
    .partialIndex({
      trashed: false,
      type: 'file'
    })

  const filesResults = await cozyClient.new.queryAll(filesQuery)
  // Making sure we're not moving any file wich might have been created by the user
  for (const file of filesResults) {
    if (file.cozyMetadata.createdByApp === manifest.data.slug) {
      log('debug', 'Moving one file')
      // Avoiding conflict
      try {
        await cozyClient.new
          .collection('io.cozy.files')
          .updateAttributes(file.id, {
            dir_id: idDestination
          })
      } catch (e) {
        if (e.status == 409) {
          // File with same name exist, this one is created by the connector, we delete it.
          log('warn', 'Deleting one freemobile duplicate')
          await cozyClient.new
            .collection('io.cozy.files')
            .deleteFilePermanently(file.id)
        } else {
          throw e
        }
      }
    }
  }
}

async function deletingDirIfEmpty(id) {
  const filesQuery = Q('io.cozy.files')
    .where({
      dir_id: id
    })
    .partialIndex({
      trashed: false,
      type: 'file'
    })
  const filesResults = await cozyClient.new.queryAll(filesQuery)
  // if dir is empty, we delete it
  if (filesResults.length === 0) {
    await cozyClient.new.collection('io.cozy.files').deleteFilePermanently(id)
    log('warn', 'Deleting empty freemobile subdirectory')
  } else {
    log('warn', `Can't delete an non empty directory ${id}`)
  }
}
