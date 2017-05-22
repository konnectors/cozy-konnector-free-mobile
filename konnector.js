let cozydb = require('cozydb');
let requestJson = require('request-json');

let moment = require('moment');
let cheerio = require('cheerio');
let fs = require('fs');
let async = require('async');
let pngjs = require('pngjs-image');
let request = require('request');

let File = require('../models/file');
let fetcher = require('../lib/fetcher');
let filterExisting = require('../lib/filter_existing');
let saveDataAndFile = require('../lib/save_data_and_file');
let linkBankOperation = require('../lib/link_bank_operation');
let localization = require('../lib/localization_manager');

let log = require('printit')({
    prefix: "Free Mobile",
    date: true
});


// Useragent is required
request = request.defaults({
    headers: {
        "User-Agent": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:53.0) Gecko/20100101 Firefox/53.0"
    }
});

// Models
let PhoneBill = cozydb.getModel('PhoneBill', {
    date: Date,
    vendor: String,
    amount: Number,
    fileId: String,
    pdfurl: String,
    binaryId: String,
    type: String
}
);

PhoneBill.all = callback => PhoneBill.request('byDate', callback);


// Konnector
module.exports = {
    name: "Free Mobile",
    slug: "freemobile",
    description: 'konnector description free mobile',
    vendorLink: "https://mobile.free.fr/",

    category: 'telecom',
    color: {
        hex: '#CD1E25',
        css: '#CD1E25'
    },

    fields: {
        login: {
            type: "text"
        },
        password: {
            type: "password"
        },
        folderPath: {
            type: "folder",
            advanced: true
        }
    },

    dataType: [
        'bill'
    ],

    models: {
        phonebill: PhoneBill
    },

    // Define model requests.
    init(callback) {
        let map = doc => emit(doc.date, doc);
        return PhoneBill.defineRequest('byDate', map, err => callback(err));
    },

    fetch(requiredFields, callback) {

        log.info("Import started");

        return fetcher.new()
            .use(prepareLogIn)
            .use(getImageAndIdentifyNumbers)
            .use(logIn)
            .use(getBillPage)
            .use(parseBillPage)
            .use(filterExisting(log, PhoneBill))
            .use(saveDataAndFile(log, PhoneBill, {
                vendor: 'freemobile',
                others: ['titulaire', 'phonenumber']
            }, ['facture']))
            .use(linkBankOperation({
                log,
                model: PhoneBill,
                identifier: 'free mobile',
                dateDelta: 14,
                amountDelta: 0.1
            }))
            .use(logOut)
            .args(requiredFields, {}, {})
            .fetch(function(err, fields, entries) {
                log.info("Import finished");

                let notifContent = null;
                if (entries.filtered && entry.filtered.length > 0) {
                    let localizationKey = 'notification bills';
                    let options = {smart_count: entries.filtered.length};
                    notifContent = localization.t(localizationKey, options);
                }

                return callback(err, notifContent);
        });
    }
};


//Disconnection of Free Mobile website
var logOut =  function(requiredFields, billInfos, data, next) {
    let logOutUrl = "https://mobile.free.fr/moncompte/index.php?logout=user";
    let options = {
        method: 'GET',
        url:  logOutUrl,
        jar: true
    };
    return request(options, function(err, res, body) {
        if (err != null) {
            log.error("Couldn't logout of Free Mobile website");
            next(err);
        }
        return next();
    });
};


// Procedure to prepare the login to Free mobile website.
var prepareLogIn = function(requiredFields, billInfos, data, next) {

    let homeUrl = "https://mobile.free.fr/moncompte/index.php?page=home";
    //First we need to get the connection page
    let options = {
        method: 'GET',
        jar: true,
        url: homeUrl
    };

    return request(options, function(err, res, body) {
        if (err != null) {
            log.error(`Cannot connect to Free Mobile : ${homeUrl}`);
            return next(err);
        }
        let loginPageData = body;
        data.imageUrlAndPosition = [];
        let $ = cheerio.load(loginPageData);
        data.token = $('input[name=token]').val();
        $('img[class="ident_chiffre_img pointer"]').each(function() {
            let imagePath = $(this).attr('src');
            let position = $(this).attr('alt');
            position = position.replace('position ', '');
            return data.imageUrlAndPosition.push({
                imagePath,
                position
            });
        });
        return next();
    });
};


var getImageAndIdentifyNumbers = function(requiredFields, billInfos, data, next) {
    //For each "position", we download the image, and identify it.
    let urlAndPosition = data.imageUrlAndPosition;
    return async.map(urlAndPosition, getImageAndIdentifyNumber, function(err, results) {
        if (err != null) {
            log.error("Coud not get or decode image");
            next(err);
        }
        data.conversionTable = results;
        return next();
    });
};


var logIn = function(requiredFields, billInfos, data, next) {
    let homeUrl = "https://mobile.free.fr/moncompte/index.php?page=home";
    let baseUrl = "https://mobile.free.fr/moncompte/";

    // We transcode the login entered by the user into the login accepted by the
    // website. Each number is changed into its position
    let transcodedLogin = transcodeLogin(requiredFields.login, data.conversionTable);
    // The login is unified (each repetition of a number in the login is
    // deleted) to download only once the small image (like a real browser would
    // do)
    let uniqueLogin = unifyLogin(transcodedLogin);


    // Ensure the download of the small image takes at least 4s
    let timerDownload = Math.round((4 / uniqueLogin.length) * 1000);

    // Each small image is downloaded. The small image is the image downloaded
    // when the user clicks on the image keyboard
    return async.eachSeries(uniqueLogin, getSmallImage(timerDownload), function(err) {
        if (err != null) {
            return next(err);
        }
        //As trancodedLogin is an array, it is changed into a string
        let login ="";
        for (let i of Array.from(transcodedLogin)) {
            login += i;
        }

        let form = {
            token: data.token,
            login_abo: login,
            pwd_abo: requiredFields.password
        };


        let options = {
            method: 'POST',
            form,
            jar: true,
            url: homeUrl,
            headers : {
                referer : homeUrl
            }
        };

        // We login to Free Mobile
        return request(options, function(err, res, body) {
            if ((err != null) || (res.headers.location == null) || (res.statusCode !== 302)) {
                log.error("Authentification error");
                if (err != null) { log.error(err); }
                if ((res.headers.location == null)) { log.error("No location"); }
                if (res.statusCode !== 302) { log.error("No 302"); }
                if ((requiredFields.password == null)) { log.error("No password"); }
                if ((requiredFields.login == null)) { log.error("No login"); }
                return next('bad credentials');
            }

            options = {
                method: 'GET',
                jar: true,
                url : baseUrl + res.headers.location,
                headers : {
                    referer : homeUrl
                }
            };
            return request(options, function(err, res, body) {
                if (err != null) {
                    return next(err);
                }
		// We check that there is no connection form (the statusCode is
                // always 302 even if the credential are wrong)
                let $ = cheerio.load(body);
                let connectionForm = $('#form_connect');
                if (connectionForm.length !== 0) {
                    log.error("Authentification error");
                    return next('bad credentials');
                }
                return next();
            });
        });
    });
};


var getBillPage = function(requiredFields, billInfos, data, next) {
    let billUrl = "https://mobile.free.fr/moncompte/index.php?page=suiviconso";
    let options = {
        method: 'GET',
        url:  billUrl,
        jar: true
    };
    return request(options, function(err, res, body) {
        if (err != null) {
            return next(err);
        }
        data.html = body;
        return next();
    });
};


// Parse the fetched page to extract bill data.
var parseBillPage = function(requiredFields, bills, data, next) {
    bills.fetched = [];
    let billUrl = `https://mobile.free.fr/moncompte/index.php?page=suiviconso&\
action=getFacture&format=dl&l=`;

    if ((data.html == null)) { return next(); }
    let $ = cheerio.load(data.html);
    //We check if the account has several lines
    //If the account has one line :
    // - Import pdfs for the line with file name = YYYYMM_freemobile.pdf
    //If multi line :
    // - Import pdfs (specific) for each line with file name =
    // YYYYMM_freemobile_NNNNNNNNNN.pdf (NN..NN is line number)
    // - Import overall pdf with name YYYYMM_freemobile.pdf

    let isMultiline = $('div.infosConso').length > 1;
    if (isMultiline) { log.info('Multi line detected'); }
    $('div.factLigne.is-hidden').each(function() {
        let amount = $($(this).find('.montant')).text();
        amount = amount.replace('€', '');
        amount = parseFloat(amount);
        let data_fact_id = $(this).attr('data-fact_id');
        let data_fact_login = $(this).attr('data-fact_login');
        let data_fact_date = $(this).attr('data-fact_date');
        let data_fact_multi = parseFloat($(this).attr('data-fact_multi'));
        let data_fact_ligne = $(this).attr('data-fact_ligne');
        let pdfUrl = billUrl + data_fact_login + "&id=" + data_fact_id + `&\
date=` + data_fact_date + "&multi=" + data_fact_multi;
        let date = moment(data_fact_date, 'YYYYMMDD');
        let bill = {
            amount,
            date,
            vendor: 'Free Mobile',
            type: 'phone'
        };

        let number = $(this).find('div.titulaire > span.numero').text();
        $(this).find('div.titulaire > span.numero').remove();
        let titulaire = $(this).find('div.titulaire').text().replace(/(\n|\r)/g, '');
        titulaire = titulaire.trim();

        if (isMultiline && !data_fact_multi) {
            bill.phonenumber = number;
            bill.titulaire = titulaire;
        }

        if (date.year() > 2011) { bill.pdfurl = pdfUrl; }

        return bills.fetched.push(bill);
    });
    return next();
};


var getImageAndIdentifyNumber = function(imageInfo, callback) {
    let baseUrl = "https://mobile.free.fr/moncompte/";
    // We download the sound number imageInfo.position. It is necessary to
    // download all the sounds, like a browser would do
    return getSound(imageInfo.position, function(err) {
        if (err != null) {
            return callback(err, null);
        }
        let options = {
            method: 'GET',
            jar: true,
            url: `${baseUrl}${imageInfo.imagePath}`,
            encoding : null
        };
        // We dowload the image located at imageInfo.imagePath
        return request(options, function(err, res, body) {
            if (err != null) {
                return callback(err, null);
            }
            return pngjs.loadImage(body, function(err, resultImage) {
                if ((resultImage.getWidth() < 24) || (resultImage.getHeight() < 28)) {
                    callback('Wrong image size', null);
                }
                let stringcheck = "";
                // We go through PNG image, but not on all the pixels, as the
                // numbers are only drawn in one specific area
                for (let x = 15; x <= 22; x++) {
                    for (let y = 12; y <= 26; y++) {
                        let idx = resultImage.getIndex(x, y);
                        let green = resultImage.getGreen(idx);
                        let blue = resultImage.getBlue(idx);
                        //We check if the pixel is "red enough"
                        if ((green + blue) < 450) {
                            stringcheck += "1";
                        } else {
                            stringcheck += "0";
                        }
                    }
                }
                let image = {
                    position : `${imageInfo.position}`,
                    numberValue : `${getNumberValue(stringcheck)}`
                };
                return callback(err, image);
            });
        });
    });
};


var getSound = function(position, callback) {
    let baseUrl = "https://mobile.free.fr/moncompte/";
    let options = {
        method: 'GET',
        url:  baseUrl+"chiffre.php?getsound=1&pos="+position,
        jar: true,
        headers : {
            referer: baseUrl+"sound/soundmanager2_flash9.swf"
        }
    };
    return request(options, function(err, res, body) {
        if (err != null) {
            return callback(err);
        }
        return callback(null);
    });
};


var getNumberValue = function(stringcheck) {
    // coffeelint: disable=max_line_length
    // symbols contains all the digits [0-9] with 0 = white pixel, 1 = red pixel
    let symbols =[
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
        ];
    // coffeelint: enable=max_line_length
    let distanceMin = stringcheck.length;
    let idxDistanceMin = 10;
    for (let i = 0; i <= 9; i++) {
        // There is a perfect match with an element of symbols
        if (stringcheck === symbols[i]) {
            return i;

        // As there is no perfect match with an element of symbols, we look for
        // the closest symbol
        } else {
            let distance = 0;
            for (let j = 0, end = stringcheck.length-1, asc = 0 <= end; asc ? j <= end : j >= end; asc ? j++ : j--) {
                if (stringcheck[j] !== symbols[i][j]) {
                    distance +=1;
                }
            }
            if (distance < distanceMin) {
                idxDistanceMin = i;
                distanceMin = distance;
            }
        }
    }

    return idxDistanceMin;
};


var transcodeLogin = function(login, conversionTable) {
    let transcoded = [];
    for (let i of Array.from(login)) {
        for (let conversion of Array.from(conversionTable)) {
            if (conversion.numberValue === i) {
                transcoded.push(conversion.position);
            }
        }
    }
    return transcoded;
};


var unifyLogin = function(login) {
    let unique = [];
    for (let digit of Array.from(login)) {
        let initTest = true;
        for (let valeur of Array.from(unique)) {
            if (valeur === digit) {
                initTest = false;
            }
        }
        if (initTest) {
            unique.push(digit);
        }
    }
    return unique;
};


// Small images are downloaded like a browser woulds do.
var getSmallImage = timer =>
    function(digit, callback) {
        let baseUrl = "https://mobile.free.fr/moncompte/";
        let options = {
            method: 'GET',
            jar: true,
            url: `${baseUrl}chiffre.php?pos=${digit}&small=1`
        };

        return request(options, function(err, res, body) {
            if (err != null) {
                return callback(err);
            }
            //Timer is necessary otherwise the connection is not possible
            return setTimeout(callback, timer, null);
        });
    }
;
