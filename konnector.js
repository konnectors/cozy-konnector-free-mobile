const moment = require('moment')
const cheerio = require('cheerio')
const async = require('async')
const pngjs = require('pngjs-image')

let request = require('request')

const {
    log,
    baseKonnector,
    filterExisting,
    linkBankOperation,
    saveDataAndFile,
    models
} = require('cozy-konnector-libs')
const Bill = models.bill

// Useragent is required
request = request.defaults({
    headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:53.0) Gecko/20100101 Firefox/53.0'
    }
})

// Konnector
module.exports = baseKonnector.createNew({
    name: 'Free Mobile',
    slug: 'freemobile',
    description: 'konnector description free mobile',
    vendorLink: 'https://mobile.free.fr/',

    category: 'telecom',
    color: {
        hex: '#CD1E25',
        css: '#CD1E25'
    },

    dataType: ['bill'],

    models: [Bill],

    // Define model requests.
    init(callback) {
        const map = doc => emit(doc.date, doc)
        return Bill.defineRequest('byDate', map, err => callback(err))
    },

    fetchOperations: [
        prepareLogIn,
        getImageAndIdentifyNumbers,
        logIn,
        getBillPage,
        parseBillPage,
        customFilterExisting,
        customSaveDataAndFile,
        customLinkBankOperations
    ]
})

const fileOptions = {
    vendor: 'freemobile',
    others: ['titulaire', 'phonenumber']
}

// Disconnection of Free Mobile website
function logOut(requiredFields, billInfos, data, next) {
    const logOutUrl = 'https://mobile.free.fr/moncompte/index.php?logout=user'
    const options = {
        method: 'GET',
        url: logOutUrl,
        jar: true
    }
    request(options, function(err, res, body) {
        if (err) {
            log('error', "Couldn't logout of Free Mobile website")
            log('error', err)
            return next('UNKNOWN_ERROR')
        }
        next()
    })
}

// Procedure to prepare the login to Free mobile website.
function prepareLogIn(requiredFields, billInfos, data, next) {
    const homeUrl = 'https://mobile.free.fr/moncompte/index.php?page=home'
    //First we need to get the connection page
    const options = {
        method: 'GET',
        jar: true,
        url: homeUrl
    }

    request(options, function(err, res, body) {
        if (err) {
            log('error', `Cannot connect to Free Mobile: ${homeUrl}`)
            return next('LOGIN_FAILED')
        }
        const loginPageData = body
        data.imageUrlAndPosition = []
        const $ = cheerio.load(loginPageData)
        data.token = $('input[name=token]').val()
        $('img[class="ident_chiffre_img pointer"]').each(function() {
            let imagePath = $(this).attr('src')
            let position = $(this).attr('alt')
            position = position.replace('position ', '')
            data.imageUrlAndPosition.push({
                imagePath,
                position
            })
        })
        next()
    })
}

function getImageAndIdentifyNumbers(requiredFields, billInfos, data, next) {
    // For each "position", we download the image, and identify it.
    const urlAndPosition = data.imageUrlAndPosition
    async.map(urlAndPosition, getImageAndIdentifyNumber, function(
        err,
        results
    ) {
        if (err) {
            log('error', 'Coud not get or decode image')
            log('error', err)
            return next('UNKNOWN_ERROR')
        }
        data.conversionTable = results
        next()
    })
}

function logIn(requiredFields, billInfos, data, next) {
    const homeUrl = 'https://mobile.free.fr/moncompte/index.php?page=home'
    const baseUrl = 'https://mobile.free.fr/moncompte/'

    // We transcode the login entered by the user into the login accepted by the
    // website. Each number is changed into its position
    const transcodedLogin = transcodeLogin(
        requiredFields.login,
        data.conversionTable
    )
    // The login is unified (each repetition of a number in the login is
    // deleted) to download only once the small image (like a real browser would
    // do)
    const uniqueLogin = unifyLogin(transcodedLogin)

    // Ensure the download of the small image takes at least 4s
    const timerDownload = Math.round(4 / uniqueLogin.length * 1000)

    // Each small image is downloaded. The small image is the image downloaded
    // when the user clicks on the image keyboard
    async.eachSeries(uniqueLogin, getSmallImage(timerDownload), function(err) {
        if (err) {
            log('error', err)
            return next('LOGIN_FAILED')
        }
        // As trancodedLogin is an array, it is changed into a string
        let login = ''
        for (let i of Array.from(transcodedLogin)) {
            login += i
        }

        let form = {
            token: data.token,
            login_abo: login,
            pwd_abo: requiredFields.password
        }

        let options = {
            method: 'POST',
            form,
            jar: true,
            url: homeUrl,
            headers: {
                referer: homeUrl
            }
        }

        // We login to Free Mobile
        request(options, function(err, res, body) {
            if (err || !res.headers.location || res.statusCode !== 302) {
                log('error', 'Authentification error')
                if (err) {
                    log('error', err)
                }
                if (!res.headers.location) {
                    log('error', 'No location')
                }
                if (res.statusCode !== 302) {
                    log('error', 'No 302')
                }
                if (!requiredFields.password) {
                    log('error', 'No password')
                }
                if (!requiredFields.login) {
                    log('error', 'No login')
                }
                return next('LOGIN_FAILED')
            }

            options = {
                method: 'GET',
                jar: true,
                url: baseUrl + res.headers.location,
                headers: {
                    referer: homeUrl
                }
            }
            request(options, function(err, res, body) {
                if (err) {
                    log('error', err)
                    return next('LOGIN_FAILED')
                }
                // We check that there is no connection form (the statusCode is
                // always 302 even if the credential are wrong)
                const $ = cheerio.load(body)
                const connectionForm = $('#form_connect')
                if (connectionForm.length !== 0) {
                    log('error', 'Authentification error')
                    return next('LOGIN_FAILED')
                }
                next()
            })
        })
    })
}

function getBillPage(requiredFields, billInfos, data, next) {
    const billUrl = 'https://mobile.free.fr/moncompte/index.php?page=suiviconso'
    const options = {
        method: 'GET',
        url: billUrl,
        jar: true
    }
    request(options, function(err, res, body) {
        if (err) {
            log('error', err)
            return next('UNKNOWN_ERROR')
        }
        data.html = body
        next()
    })
}

// Parse the fetched page to extract bill data.
function parseBillPage(requiredFields, bills, data, next) {
    bills.fetched = []
    const billUrl =
        'https://mobile.free.fr/moncompte/index.php?page=suiviconso&action=getFacture&format=dl&l='

    if (!data.html) {
        log('info', 'No new bills to import')
        return next()
    }
    const $ = cheerio.load(data.html)

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
        const data_fact_id = $(this).attr('data-fact_id')
        const data_fact_login = $(this).attr('data-fact_login')
        const data_fact_date = $(this).attr('data-fact_date')
        const data_fact_multi = parseFloat($(this).attr('data-fact_multi'))
        const data_fact_ligne = $(this).attr('data-fact_ligne')
        const pdfUrl = `${billUrl}${data_fact_login}&id=${data_fact_id}&date=${data_fact_date}&multi=${data_fact_multi}`
        const date = moment(data_fact_date, 'YYYYMMDD')

        let bill = {
            amount,
            date,
            vendor: 'Free Mobile',
            type: 'phone'
        }

        const number = $(this).find('div.titulaire > span.numero').text()
        $(this).find('div.titulaire > span.numero').remove()
        const titulaire = $(this)
            .find('div.titulaire')
            .text()
            .replace(/(\n|\r)/g, '')
            .trim()

        if (isMultiline && !data_fact_multi) {
            bill.phonenumber = number
            bill.titulaire = titulaire
        }

        if (date.year() > 2011) {
            bill.pdfurl = pdfUrl
        }

        bills.fetched.push(bill)
    })
    next()
}

function getImageAndIdentifyNumber(imageInfo, callback) {
    const baseUrl = 'https://mobile.free.fr/moncompte/'
    // We download the sound number imageInfo.position. It is necessary to
    // download all the sounds, like a browser would do
    getSound(imageInfo.position, function(err) {
        if (err) {
            log('error', err)
            return callback(err, null)
        }
        const options = {
            method: 'GET',
            jar: true,
            url: `${baseUrl}${imageInfo.imagePath}`,
            encoding: null
        }
        // We dowload the image located at imageInfo.imagePath
        request(options, function(err, res, body) {
            if (err) {
                log('error', err)
                return callback(err, null)
            }
            pngjs.loadImage(body, function(err, resultImage) {
                if (
                    resultImage.getWidth() < 24 ||
                    resultImage.getHeight() < 28
                ) {
                    callback('Wrong image size', null)
                }
                let stringcheck = ''
                // We go through PNG image, but not on all the pixels, as the
                // numbers are only drawn in one specific area
                for (let x = 15; x <= 22; x++) {
                    for (let y = 12; y <= 26; y++) {
                        let idx = resultImage.getIndex(x, y)
                        let green = resultImage.getGreen(idx)
                        let blue = resultImage.getBlue(idx)
                        //We check if the pixel is "red enough"
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
                callback(err, image)
            })
        })
    })
}

function getSound(position, callback) {
    const baseUrl = 'https://mobile.free.fr/moncompte/'
    const options = {
        method: 'GET',
        url: baseUrl + 'chiffre.php?getsound=1&pos=' + position,
        jar: true,
        headers: {
            referer: baseUrl + 'sound/soundmanager2_flash9.swf'
        }
    }
    request(options, callback)
}

function getNumberValue(stringcheck) {
    // symbols contains all the digits [0-9] with 0 = white pixel, 1 = red pixel
    let symbols = [
        '001111111111110011111111111111111111111111111110000000000011110000000000011111111111111111011111111111111001111111111110', //0
        '001110000000000001110000000000001110000000000011111111111111111111111111111111111111111111000000000000000000000000000000', //1
        '011110000001111011110000111111111000001111111110000011110011110000111100011111111111000011011111110000011001111000000011', //2
        '011100000011110111100000011111111000110000111110000110000011110001110000011111111111111111011111111111110001110001111100', //3
        '000000011111000000001111111000000111110011000011110000011000111111111111111111111111111111111111111111111000000000011000', //4
        '111111110011110111111110011111111001110000111111001100000011111001100000011111001111111111111001111111111010000111111110', //5
        '001111111111110011111111111111111111111111111110001100000011110001100000011111001111111111111101111111111011100111111110', //6
        '111000000000000111000000000000111000000011111111000011111111111011111111111111111111000000111111000000000111100000000000', //7
        '001110001111110011111111111111111111111111111110000110000011110000110000011111111111111111011111111111111001111001111110', //8
        '001111111000110011111111100111111111111100111110000001100011110000001100011111111111111111011111111111111001111111111110' //9
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
                let j = 0, end = stringcheck.length - 1, asc = 0 <= end;
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
    return function(digit, callback) {
        const baseUrl = 'https://mobile.free.fr/moncompte/'
        const options = {
            method: 'GET',
            jar: true,
            url: `${baseUrl}chiffre.php?pos=${digit}&small=1`
        }

        request(options, function(err, res, body) {
            if (err) {
                return callback(err)
            }
            // Timer is necessary otherwise the connection is not possible
            setTimeout(callback, timer, null)
        })
    }
}

function customFilterExisting(requiredFields, entries, data, next) {
    filterExisting(null, Bill)(requiredFields, entries, data, next)
}

function customSaveDataAndFile(requiredFields, entries, data, next) {
    saveDataAndFile(null, Bill, fileOptions, ['facture'])(
        requiredFields,
        entries,
        data,
        next
    )
}

function customLinkBankOperations(requiredFields, entries, data, next) {
    linkBankOperation({
        log,
        model: Bill,
        identifier: 'free mobile',
        dateDelta: 14,
        amountDelta: 0.1
    })
}
