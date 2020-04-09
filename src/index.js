// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://151ddd2738c745829afbed143c7b5ef0:10f0842a61c94f6cbc542de579104e86@sentry.cozycloud.cc/24'

const moment = require('moment')

const { log, BaseKonnector, requestFactory } = require('cozy-konnector-libs')

let request = requestFactory({
  cheerio: true,
  json: false,
  // debug: true,
  jar: true
})

const login = require('./login.js')

module.exports = new BaseKonnector(async function fetch(fields) {
  await login(fields)

  const $ = await getBillPage()
  const bills = await parseBillPage($)
  await this.saveBills(bills, fields.folderPath, {
    fileIdAttributes: ['vendor', 'contractId', 'date', 'amount'],
    linkBankOperations: false
  })
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
