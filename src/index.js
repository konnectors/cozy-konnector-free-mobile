// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://151ddd2738c745829afbed143c7b5ef0:10f0842a61c94f6cbc542de579104e86@sentry.cozycloud.cc/24'

const moment = require('moment')
const pngjs = require('pngjs')
const bluebird = require('bluebird')

const {
  log,
  BaseKonnector,
  requestFactory,
  errors
} = require('cozy-konnector-libs')

let request = requestFactory({
  cheerio: true,
  json: false,
  // debug: true,
  jar: true
})

module.exports = new BaseKonnector(async function fetch(fields) {
  loginValidate(fields.login)
  const { imageUrlAndPosition, token } = await prepareLogIn()
  const conversionTable = await getImageAndIdentifyNumbers(imageUrlAndPosition)
  await logIn(fields, token, conversionTable)
  const $ = await getBillPage()
  const entries = await parseBillPage($)
  await this.saveBills(entries, fields.folderPath, {
    identifiers: 'free mobile',
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
  })
})

function loginValidate(login) {
  if (!login.match(/^\d+$/)) {
    log('error', 'detected not numerical chars')
    throw new Error('LOGIN_FAILED.WRONG_LOGIN_FORM')
  }
}

// Procedure to prepare the login to Free mobile website.
async function prepareLogIn() {
  log('Preparing login')
  const result = {}
  const homeUrl = 'https://mobile.free.fr/moncompte/index.php?page=home'

  // First we need to get the connection page
  const $ = await request(homeUrl)
  result.imageUrlAndPosition = []
  result.token = $('input[name=token]').val()
  $('img[class="ident_chiffre_img pointer"]').each(function() {
    const imagePath = $(this).attr('src')
    let position = $(this).attr('alt')
    position = position.replace('position ', '')
    result.imageUrlAndPosition.push({
      imagePath,
      position
    })
  })
  return result
}

function getImageAndIdentifyNumbers(urlAndPosition) {
  // For each "position", we download the image, and identify it.
  request = requestFactory({
    cheerio: false,
    json: false,
    jar: true
  })
  return bluebird
    .mapSeries(urlAndPosition, getImageAndIdentifyNumber)
    .catch(err => {
      log('error', 'Coud not get or decode image')
      log('error', err.message)
      throw new Error('UNKNOWN_ERROR')
    })
}

function recognizeNumber(pngData, imageInfo) {
  return new Promise((resolve, reject) => {
    const png = new pngjs.PNG()
    png.parse(pngData)
    png.on('error', () => {
      reject(new Error('Invalid number image'))
    })
    png.on('parsed', function() {
      if (this.width < 24 || this.height < 28) {
        reject(new Error('Wrong image size'))
      }
      let stringcheck = ''
      // We go through PNG image, but not on all the pixels, as the
      // numbers are only drawn in one specific area
      for (let x = 15; x <= 22; x++) {
        for (let y = 12; y <= 26; y++) {
          let idx = (this.width * y + x) << 2
          let green = this.data[idx + 1]
          let blue = this.data[idx + 2]
          // We check if the pixel is "red enough"
          if (green + blue < 450) {
            stringcheck += '1'
          } else {
            stringcheck += '0'
          }
        }
      }
      const image = {
        position: `${imageInfo.position}`,
        numberValue: `${getNumberValue(stringcheck)}`
      }
      resolve(image)
    })
  })
}

function getImageAndIdentifyNumber(imageInfo) {
  const baseUrl = 'https://mobile.free.fr/moncompte/'

  // We download the sound number imageInfo.position. It is necessary to
  // download all the sounds, like a browser would do
  return getSound(imageInfo.position)
    .then(() =>
      request({
        url: `${baseUrl}${imageInfo.imagePath}`,
        encoding: null
      })
    )
    .then(body => {
      return recognizeNumber(body, imageInfo)
    })
}

function getSound(position) {
  const baseUrl = 'https://mobile.free.fr/moncompte/'
  return request({
    url: `${baseUrl}chiffre.php?getsound=1&pos=${position}`,
    headers: {
      referer: baseUrl + 'sound/soundmanager2_flash9.swf'
    }
  }).catch(err => {
    log('error', err.message)
    log('error', 'error while getting sound')
  })
}

function getNumberValue(stringcheck) {
  // symbols contains all the digits [0-9] with 0 = white pixel, 1 = red pixel
  let symbols = [
    '001111111111110011111111111111111111111111111110000000000011110000000000011111111111111111011111111111111001111111111110', // 0
    '001110000000000001110000000000001110000000000011111111111111111111111111111111111111111111000000000000000000000000000000', // 1
    '011110000001111011110000111111111000001111111110000011110011110000111100011111111111000011011111110000011001111000000011', // 2
    '011100000011110111100000011111111000110000111110000110000011110001110000011111111111111111011111111111110001110001111100', // 3
    '000000011111000000001111111000000111110011000011110000011000111111111111111111111111111111111111111111111000000000011000', // 4
    '111111110011110111111110011111111001110000111111001100000011111001100000011111001111111111111001111111111010000111111110', // 5
    '001111111111110011111111111111111111111111111110001100000011110001100000011111001111111111111101111111111011100111111110', // 6
    '111000000000000111000000000000111000000011111111000011111111111011111111111111111111000000111111000000000111100000000000', // 7
    '001110001111110011111111111111111111111111111110000110000011110000110000011111111111111111011111111111111001111001111110', // 8
    '001111111000110011111111100111111111111100111110000001100011110000001100011111111111111111011111111111111001111111111110' // 9
  ]
  let distanceMin = stringcheck.length
  let idxDistanceMin = 10
  for (let i = 0; i <= 9; i++) {
    if (stringcheck === symbols[i]) {
      // There is a perfect match with an element of symbols
      return i
    } else {
      // As there is no perfect match with an element of symbols, we look for
      // the closest symbol
      let distance = 0
      for (
        let j = 0, end = stringcheck.length - 1, asc = end >= 0;
        asc ? j <= end : j >= end;
        asc ? j++ : j--
      ) {
        if (stringcheck[j] !== symbols[i][j]) {
          distance += 1
        }
      }
      if (distance < distanceMin) {
        idxDistanceMin = i
        distanceMin = distance
      }
    }
  }
  return idxDistanceMin
}

async function logIn(fields, token, conversionTable) {
  const homeUrl = 'https://mobile.free.fr/moncompte/index.php?page=home'

  request = requestFactory({
    cheerio: true,
    json: false,
    jar: true
  })

  // We transcode the login entered by the user into the login accepted by the
  // website. Each number is changed into its position
  const transcodedLogin = transcodeLogin(fields.login, conversionTable)
  // The login is unified (each repetition of a number in the login is
  // deleted) to download only once the small image (like a real browser would
  // do)
  const uniqueLogin = unifyLogin(transcodedLogin)

  // Ensure the download of the small image takes at least 4s
  const timerDownload = Math.round((4 / uniqueLogin.length) * 1000)

  // Each small image is downloaded. The small image is the image downloaded
  // when the user clicks on the image keyboard
  try {
    await bluebird.each(uniqueLogin, getSmallImage(timerDownload))
  } catch (err) {
    log('error', err.message)
    throw new Error('error while transcoding key images')
  }

  // As trancodedLogin is an array, it is changed into a string
  let login = ''
  for (let i of Array.from(transcodedLogin)) {
    login += i
  }

  // We login to Free Mobile
  log('info', 'POST login')
  let $
  try {
    $ = await request.post({
      form: {
        token,
        login_abo: login,
        pwd_abo: fields.password
      },
      url: homeUrl,
      headers: {
        referer: homeUrl
      }
    })
  } catch (err) {
    log('error', 'error while post login')
    log('error', err.message)
    throw new Error(errors.VENDOR_DOWN)
  }

  const msg = $('.alert-info').text()
  const connectionForm = $('#form_connect')
  if (msg && msg.includes('mot de passe incorrect')) {
    log('error', msg)
    throw new Error(errors.LOGIN_FAILED)
  }
  if (connectionForm.length !== 0) {
    log('error', 'login form still visible')
    throw new Error(errors.LOGIN_FAILED)
  }

  log('info', 'Successfully logged in.')
}

function getBillPage() {
  return request('https://mobile.free.fr/moncompte/index.php?page=suiviconso')
}

// Parse the fetched page to extract bill data.
function parseBillPage($) {
  const bills = []
  const billUrl =
    'https://mobile.free.fr/moncompte/index.php?page=suiviconso&action=getFacture&format=dl&l='

  // We check if the account has several lines
  // If the account has one line :
  //  - Import pdfs for the line with file name = YYYYMM_freemobile.pdf
  // If multi line :
  //  - Import pdfs (specific) for each line with file name =
  //    YYYYMM_freemobile_NNNNNNNNNN.pdf (NN..NN is line number)
  //  - Import overall pdf with name YYYYMM_freemobile.pdf
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

    if (isMultiline && !dataFactMulti) {
      bill.phonenumber = number
      bill.titulaire = titulaire
    }

    if (date.year() > 2011) {
      bill.fileurl = pdfUrl
      bill.filename = getFileName(date)
    }

    bills.push(bill)
  })
  return bills
}

function transcodeLogin(login, conversionTable) {
  let transcoded = []
  for (let i of Array.from(login)) {
    for (let conversion of Array.from(conversionTable)) {
      if (conversion.numberValue === i) {
        transcoded.push(conversion.position)
      }
    }
  }
  return transcoded
}

function unifyLogin(login) {
  let unique = []
  for (let digit of Array.from(login)) {
    let initTest = true
    for (let valeur of Array.from(unique)) {
      if (valeur === digit) {
        initTest = false
      }
    }
    if (initTest) {
      unique.push(digit)
    }
  }
  return unique
}

// Small images are downloaded like a browser woulds do.
function getSmallImage(timer) {
  return function(digit) {
    const baseUrl = 'https://mobile.free.fr/moncompte/'
    return request(`${baseUrl}chiffre.php?pos=${digit}&small=1`).then(() => {
      return new Promise(resolve => {
        setTimeout(() => {
          resolve()
        }, timer)
      })
    })
  }
}

function getFileName(date) {
  return `${date.format('YYYYMM')}_freemobile.pdf`
}
