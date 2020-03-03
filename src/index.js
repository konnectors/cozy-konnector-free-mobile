// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://151ddd2738c745829afbed143c7b5ef0:10f0842a61c94f6cbc542de579104e86@sentry.cozycloud.cc/24'

const moment = require('moment')

const {
  log,
  BaseKonnector,
  requestFactory,
  cozyClient,
  utils
} = require('cozy-konnector-libs')

let request = requestFactory({
  cheerio: true,
  json: false,
  // debug: true,
  jar: true
})

const login = require('./login.js')

module.exports = new BaseKonnector(async function fetch(fields) {
  const clientName = await login(fields)
  // As login need to be successfull to reach this point, login is a valid data
  const accountDirectoryLabel = `${clientName} (${fields.login})`

  // Disable this function to get a degraded standalone mode working
  // (not in cozy-client-js-stub)
  this._account = await ensureAccountDirectoryLabel(
    this._account,
    fields,
    accountDirectoryLabel
  )

  const $ = await getBillPage()
  const bills = await parseBillPage($)
  await this.saveBills(bills, fields.folderPath, {
    fileIdAttributes: ['vendor', 'contractId', 'date', 'amount'],
    identifiers: 'free mobile',
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
  })
  const parentDir = await cozyClient.files.statByPath(fields.folderPath)
  const filesAndDirFree = await utils.queryAll('io.cozy.files', {
    dir_id: parentDir._id
  })
  const filesFree = filesAndDirFree.filter(file => file.type === 'file') // Remove directories
  const billsFree = await utils.queryAll('io.cozy.bills', {
    vendor: 'Free Mobile'
  })
  await cleanScrapableBillsAndFiles(filesFree, billsFree)
})

function getBillPage() {
  return request('https://mobile.free.fr/moncompte/index.php?page=suiviconso')
}

// Parse the fetched page to extract bill data.
function parseBillPage($) {
  const bills = []
  const billUrl =
    'https://mobile.free.fr/moncompte/index.php?page=suiviconso&action=getFacture&format=dl&l='

  // Set as multi line if we detect more than 1 line available
  const isMultiline = $('div.infosConso').length > 1
  if (isMultiline) {
    log('info', 'Multi line detected')
  }
  $('div.factLigne.is-hidden').each(function() {
    let amount = $($(this).find('.montant')).text()
    amount = amount.replace('€', '')
    amount = parseFloat(amount)
    const dataFactId = $(this).attr('data-fact_id')
    const dataFactLogin = $(this).attr('data-fact_login')
    const dataFactDate = $(this).attr('data-fact_date')
    const dataFactMulti = parseFloat($(this).attr('data-fact_multi'))
    const pdfUrl = `${billUrl}${dataFactLogin}&id=${dataFactId}&date=${dataFactDate}&multi=${dataFactMulti}`
    const date = moment(dataFactDate, 'YYYYMMDD')

    let bill = {
      amount,
      date: date.toDate(),
      vendor: 'Free Mobile',
      type: 'phone',
      fileAttributes: {
        metadata: {
          classification: 'invoicing',
          datetime: date.toDate(),
          datetimeLabel: 'issueDate',
          contentAuthor: 'free',
          subClassification: 'invoice',
          categories: ['phone'],
          issueDate: date.toDate(),
          invoiceNumber: dataFactId,
          contractReference: dataFactLogin,
          isSubscription: true
        }
      }
    }
    const number = $(this)
      .find('div.titulaire > span.numero')
      .text()
    $(this)
      .find('div.titulaire > span.numero')
      .remove()
    const titulaire = $(this)
      .find('div.titulaire')
      .text()
      .replace(/(\n|\r)/g, '')
      .trim()
    bill.phonenumber = number.replace(/ /g, '')
    bill.titulaire = titulaire
    bill.fileurl = pdfUrl
    bill.filename = `${date.format('YYYYMM')}_freemobile_${bill.amount.toFixed(
      2
    )}€.pdf`

    if (isMultiline && dataFactMulti === 1) {
      bill.phonenumber = 'multilignes' // Phone number is empty for multilignes bill
      bill.contractId = bill.phonenumber
      bill.contractLabel = `Récapitulatifs Multilignes (${bill.titulaire})`
    } else {
      bill.contractId = bill.phonenumber
      bill.contractLabel = `${bill.phonenumber} (${bill.titulaire})`
    }

    bills.push(bill)
  })
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

async function cleanScrapableBillsAndFiles(filesFree, billsFree) {
  const filenamesToDelete = generate12LastOldFilename()
  const filesDeleted = []
  const billsToDelete = []
  for (const file of filesFree) {
    if (filenamesToDelete.includes(file.name)) {
      filesDeleted.push(file)
      // Deleting file
      await cozyClient.files.trashById(file._id)
      // Deleting bill
      const bill = isABillMatch(file, billsFree)
      if (bill) {
        billsToDelete.push(bill)
      }
    }
  }
  // Deleting all necessary bills at once
  await utils.batchDelete('io.cozy.bills', billsToDelete)
}

function generate12LastOldFilename() {
  let filenameList = []
  const datetimeNow = new Date()
  // Warning remember january is month 0
  const monthNow = datetimeNow.getMonth()
  const yearNow = datetimeNow.getFullYear()
  // Get the 12 last filename
  for (let i = 0; i < 12; i++) {
    let month = monthNow + 1 - i // Human number of the month aimed
    let year = yearNow
    if (month <= 0) {
      month = month + 12
      year = year - 1
    }
    month = ('0' + month).substr(-2) // Adding leading 0 if necessary
    const filename = `${year}${month}_freemobile.pdf`
    filenameList.push(filename)
  }
  return filenameList
}

/* Return the first bill matching the file passed
 */
function isABillMatch(file, billsFree) {
  for (const bill of billsFree) {
    if (bill.invoice === `io.cozy.files:${file._id}`) {
      return bill
    }
  }
  return false
}
