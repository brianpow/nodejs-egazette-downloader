'use strict'

var Promise = require("bluebird")
var mkdirp = require("mkdirp")
var fs = require('graceful-fs')
var path = require("path")
var Url = require("url")
var cheerio = require("cheerio")
var requestretry = require('requestretry')
var request = require('request') //(requestretry);
const http = require("http")
http.globalAgent.maxSockets = 1
var unique = require('array-unique')
var program = require('commander')
var process = require('process')
var sanitize = require("sanitize-filename")
var util = require('util')
var tracer = require('tracer')
var logger = tracer.console({
    format: ["{{timestamp}} <{{title}}> {{message}}",
        {
            error: "{{timestamp}} <{{title}}> {{message}} (in {{file}}:{{line}})\nCall Stack:\n{{stack}}" // error format
        }
    ],
    dateformat: "HH:MM:ss.L"
});;

var logger = tracer.console({
    format: ["{{timestamp}} <{{title}}> {{message}} (in {{file}}:{{line}})",
        {
            error: "{{timestamp}} <{{title}}> {{message}} (in {{file}}:{{line}})\nCall Stack:\n{{stack}}" // error format
        }
    ],
    dateformat: "HH:MM:ss.L"
});;


var main = {
    chinese: 'http://www.gld.gov.hk/egazette/tc_chi/gazette/toc.php',
    english: 'http://www.gld.gov.hk/egazette/english/gazette/toc.php'
}

var baseRequest, baseReq
var noOfPages

program
    .version('0.0.1')
    .usage('[options] <no of pages>')
    .option('-o, --output <path>', 'Output directory')
    .option('-c, --toc <filename>', 'load TOC from filename instead of downloading.')
    .option('-l, --language <language>', 'Language (chinese or english)', /^(chinese|english)$/, 'chinese')
    .option('-y, --year <year, ...>', 'Download only issue published in specific year(s) (e.g. "-y 2012-2013,2015,2016-" )', yearList)
    .option('-E, --volume <volume, ...>', 'Download only specific volume(s) (e.g. "-E 1-2,5,9" )', numberList)
    .option('-u, --no <volume number, ...>', 'Download only specific volume numbers(s), same syntax as --volume', numberList)
    .option('-s, --search <keywords or regular expression>', 'Download only volumes with title contains <keywords> or match <regular expression>', "")
    .option('-g, --gazette-type <volume type, ...>', 'Download only specific type of volume(s) (0=General Issue, 1=Extraordinary Issue)', numberList)
    .option('-n, --notice-type <notice type, ...>', 'Download only specific notice(s) (0=Government Notice,1=Supplement 1,...)', numberList)
    .option('-w, --wait <time in ms>', 'Wait between each wave of pdf download, default is 500ms', parseInt, 500)
    .option('-m, --max-connection <max connection>', 'Maximum simultaneous HTTP connections, default is 4', parseInt, 4)
    .option('-t, --timeout <time in ms>', 'Timeout for each HTTP request, default is 60000ms', parseInt, 60000)
    .option('-r, --retry <count>', 'Retry if HTTP connections failed, default is 10', parseInt, 10)
    .option('-R, --retry-delay <time in ms>', 'Retry dealy if HTTP connections failed, default is 60000ms', parseInt, 60000)
    .option('-a, --user-agent <user agent>', 'User agent in HTTP request header, default is "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:15.0) Gecko/20100101 Firefox/15.0.1"', 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:15.0) Gecko/20100101 Firefox/15.0.1')
    .option('-d, --no-download', 'Don\'t save any pdf files')
    .option('-e, --export <path>', 'Append found pdf links and title in tab separated format')
    .option('-D, --debug [filename]', 'Save debug information (default: toc.txt)', "toc.txt")
    .option('-v, --verbose', 'Be more verbose (max -vvvv)', increaseVerbosity, 0)
    .arguments('<no of pages>')
    .action(function (_noOfPages) {
        baseRequest = requestretry.defaults({
            maxAttempts: program.retry,
            retryDelay: program.retryDelay,
            pool: {
                maxSockets: program.maxConnection
            },
            timeout: program.timeout,
            headers: {
                'User-Agent': program.userAgent
            }
        })
        baseReq = request.defaults({
            pool: {
                maxSockets: program.maxConnection
            },
            timeout: program.timeout,
            headers: {
                'User-Agent': program.userAgent
            }
        })
        program.output = program.output || process.cwd()
        if (program.export)
            program.export = path.join(program.output, program.export)

        let re = isRegExp(program.search)
        if (re)
            program.search = new RegExp(re[0], re[1])

        noOfPages = parseInt(_noOfPages)
        if (noOfPages)
            if (program.toc) {
                let toc = fs.readFileSync(program.toc).toString().split("\n")
                Promise.resolve(toc).then(getVolumes).catch(function (err) {
                    if (program.debug)
                        fs.appendFileSync("error.txt", util.format("%s\t%s\n", new Date().toISOString(), err.toString()))
                    logger.error(err)
                }).finally(removeDupe)
            }
        else {
            getToc(main[program.language], [], _noOfPages).then(getVolumes).catch(function (err) {
                if (program.debug)
                    fs.appendFileSync("error.txt", util.format("%s\t%s\n", new Date().toISOString(), err.toString()))
                logger.error(err)
            }).finally(removeDupe)
        } else {
            program.outputHelp()
            process.exit(1)
        }
    })
    .parse(process.argv)

if (!noOfPages || !parseInt(noOfPages)) {
    program.outputHelp()
    process.exit(1)
}

function increaseVerbosity(v, total) {
    return total + 1
}

function pushUnique(arr, val) {
    if (Array.isArray(arr) && arr.indexOf(val) == -1)
        arr.push(val)
    return arr
}

function removeDupe() {
    if (program.export) {
        fs.stat(program.export, (err, stats) => {
            if (!err) {
                logger.log("Removing duplicate links...")
                let rows = fs.readFileSync(program.export, {
                    encoding: "utf8"
                }).split("\n")
                rows = unique(rows)
                fs.writeFileSync(program.export, rows.join("\n"))
            }
            logger.log("All done!")
        })
    } else
        logger.log("All done!")
}

function isRegExp(val) {
    let matches = val.match(/^\/(.+)\/(\w+)?$/)
    if (matches) {
        matches[2] = matches[2] || ""
        return matches.splice(1)
    }
    return null
}

function yearList(val) {
    let tmp = val.split(',')
    let tmp2 = []
    for (let i in tmp)
        if (!isNaN(tmp[i]))
            tmp2.push(Number(tmp[i]))
    else {
        let matches = tmp[i].match(/^(\d+)-(\d+)?$/)
        if (matches != null) {
            if (!matches[2])
                matches[2] = new Date().getFullYear()
            for (let j = Number(matches[1]); j <= Number(matches[2]); j++)
                tmp2.push(j)
        }
    }

    return unique(tmp2)
}

function numberList(val) {
    let tmp = val.split(',')
    let tmp2 = []
    for (let i in tmp)
        if (!isNaN(tmp[i]))
            tmp2.push(Number(tmp[i]))
    else {
        let matches = tmp[i].match(/^(\d+)-(\d+)$/)
        if (matches != null) {
            for (let j = Number(matches[1]); j <= Number(matches[2]); j++)
                tmp2.push(j)
        }
    }

    return unique(tmp2)
}

function getToc(nextPage, volumeUrls, max_volumes) {
    logger.log("Parsing TOC..")
    return new Promise(function (resolve, reject) {
        function get(nextPage, volumeUrls, maxVolumes, pagesParsed) {
            return baseRequest.get(nextPage, {
                timeout: program.timeout
            }, function (error, response, body) {
                if (!error && response.statusCode == 200) {
                    pagesParsed++
                    let $ = cheerio.load(body)
                    if (program.verbose > 2)
                        logger.log("Parsing: %s", nextPage)
                    $("a[href^='volume.php']").each(function () {
                        let uri = Url.parse(this.attribs['href'], {
                            parseQueryString: true
                        })

                        if (!program.gazetteType || program.gazetteType.indexOf(parseInt(uri.query.extra)) != -1)
                            if (!program.year || program.year.indexOf(parseInt(uri.query.year)) != -1)
                                if (!program.volume || program.volume.indexOf(parseInt(uri.query.volume)) != -1)
                                    if (!program.no || program.no.indexOf(parseInt(uri.query.no)) != -1)
                                        pushUnique(volumeUrls, Url.resolve(nextPage, this.attribs['href']))
                    })

                    let next = $("img[name=nextBtn]").parent()
                    if (next.length && maxVolumes > 1) {
                        return get(Url.resolve(nextPage, next[0].attribs['href']), volumeUrls, --maxVolumes, pagesParsed)
                    } else {
                        volumeUrls = unique(volumeUrls)
                        if (program.debug)
                            fs.writeFileSync("toc.txt", volumeUrls.join("\n"))
                        logger.log("done! %d pages parsed, %d links found", pagesParsed, volumeUrls.length)
                        resolve(volumeUrls)
                    }
                } else {
                    reject(error)
                }
            })
        }
        get(nextPage, volumeUrls, max_volumes, 0)

    })
}

function resize(arr, size, defval) {
    var delta = arr.length - size;

    if (delta > 0) {
        arr.length = size;
    } else {
        while (delta++ < 0) {
            arr.push(defval);
        }
    }
}

function getVolumes(volumeUrls) {
    logger.log("Parsing volumes...")
    return new Promise(function (resolve, reject) {
        function get(volumeUrls, volumeTitles, pdf_urls, pdf_titles) {
            if (!Array.isArray(volumeTitles))
                volumeTitles = []

            resize(volumeTitles, volumeUrls.length, [])

            let requests = []
            let downloaded_pdf = []

            for (let i in volumeUrls) {
                let url = volumeUrls[i]
                let title = volumeTitles[i]

                requests.push((function (_url, _title) {
                    return function () {

                        baseRequest.get(_url, {
                            timeout: program.timeout
                        }, function (error, response, body) {

                            let new_volumes_url = []
                            let new_titles = []
                            if (!error && response.statusCode == 200) {
                                if (program.verbose > 3) logger.log("Downloading %s success!", _url)
                                let $ = cheerio.load(body)
                                let x = parseUrls($, _url, _title)
                                new_volumes_url = x[0], new_titles = x[1]

                                let requests = []
                                $("a[href$='.pdf']").each(function () {
                                    let absoluteUrl = Url.resolve(_url, this.attribs['href'])

                                    if (program.verbose > 3) logger.log("getVolumes(): URL found: %s", absoluteUrl)
                                    let full_title = _title.join(", ") + ", " + $(this).text().trim()
                                    if (program.export)
                                        fs.appendFileSync(program.export, [absoluteUrl].concat(_title).concat([$(this).text().trim()]).join("\t") + "\n")

                                    if (!program.noDownload) {
                                        if (downloaded_pdf.indexOf(absoluteUrl) == -1 && !$(this).text().match(/^\d+$/) && !$(this).text() != "--") {

                                            let url_parts = Url.parse(absoluteUrl)
                                            let path_parts

                                            if (path.sep == "\\")
                                                path_parts = path.parse(program.output + url_parts['path'].replace(/\//g, "\\"))
                                            else
                                                path_parts = path.parse(program.output + url_parts['path'])
                                            let name_suffix = sanitize($(this).text().replace(path_parts['name'], ""), {
                                                replacement: "-"
                                            })

                                            path_parts['base'] = sanitize(path_parts['name'] + " " + name_suffix + path_parts['ext'])
                                            let output_pathname = path.format(path_parts)

                                            if (!program.search || (program.search && (typeof program.search == "object" && program.search.test(full_title) || full_title.indexOf(program.search) != -1))) {
                                                if (name_suffix != "--") {
                                                    mkdirp.sync(path_parts['dir'])

                                                    requests.push((function (absolute_url, output_pathname, _title) {
                                                        return function () {
                                                            return save(absolute_url, output_pathname, _title)
                                                        }
                                                    })(absoluteUrl, output_pathname, _title))

                                                    downloaded_pdf.push(absoluteUrl)
                                                }
                                            } else {
                                                if (program.verbose > 1)
                                                    logger.log("[Text Unmatched] Skipping %s to %s of %s because of unmatchedd search filter", absoluteUrl, output_pathname, _title.join(", "))

                                            }
                                        }
                                    }
                                })
                                if (requests.length)
                                    run(requests)
                                if (new_volumes_url.length) {

                                    let [u, t] = unique2(new_volumes_url, new_titles)
                                    return get(u, t)
                                }
                            } else {
                                logger.error("Downloading %s with text failed.", url, _title.join(", "))
                                if (!error)
                                    logger.log(response);
                                else
                                    logger.error(error)
                            }

                        })
                    }
                })(url, title))
            }
            run(requests)
        }
        if (Array.isArray(volumeUrls))
            Promise.map(volumeUrls, function (url) {}, {
                concurrency: 1
            }).
        else
        get(volumeUrls)
    })
}

function run(requests) {
    if (requests.length > 0) {
        let request = requests.shift()
        request()
        if (requests.length > 0) {
            setTimeout(function () {
                run(requests)
            }, program.wait)
        }
    }
}

function parseUrls($, url, title) {
    let new_volumes_url = [],
        new_titles = []

    $("a[href^='?year=']").each(function () {
        if (program.verbose > 3) logger.log("getVolumes(): URL found: %s", Url.resolve(url, this.attribs['href']))
        let uri = Url.parse(this.attribs['href'], {
            parseQueryString: true
        })
        if (!program.noticeType || program.noticeType.indexOf(parseInt(uri.query.type)) != -1) {
            let new_url = Url.resolve(url, this.attribs['href'])
            new_volumes_url.push(new_url)
            let new_title = title.concat()

            new_title.push($(this).text().trim())
            new_titles.push(new_title)
        }
    })

    return [new_volumes_url, new_titles]
}

function unique2(arr, arr2) {
    if (!Array.isArray(arr) || !Array.isArray(arr2)) {
        throw new TypeError('array-unique expects an array.')
    }

    if (arr.length != arr2.length) {
        throw new TypeError('array-unique expects two array should be the same size.')
    }

    var len = arr.length
    var i = -1

    while (i++ < len) {
        var j = i + 1

        for (; j < arr.length; ++j) {
            if (arr[i] === arr[j]) {
                arr.splice(j--, 1)
                arr2.splice(j--, 1)
            }
        }
    }
    return [arr, arr2]
}

function _save(url, file, aTime, mTime) {
    logger.log("_save %s %s %s %s", url, file, aTime, mTime)
    let fileStream = fs.createWriteStream(file).on('error', (err) => {
        console.error(err)
    }).on('finish', function () {
        let stat = fs.statSync(file)
        if (program.verbose>1)
            logger.log("%s saved to %s with size %d", url, file, stat['size'])
        if (aTime !== null && mTime !== null)
        {
            if (program.verbose > 2)
                logger.log("[Fix Date] %s : a:%s, m:%s ", file, aTime, mTime)
            fs.utimesSync(file, aTime, mTime)
        }
        else {
            logger.error("[Error] %s, %s, %s", file, aTime, mTime)
        }
    })
    return baseRequest.get(url).pipe(fileStream)

}

function save(url, file, _title) {
    return baseRequest.head(url, {
        timeout: program.timeout
    }, ).on('error', (err) => {
        logger.log(err)
    }).on('response', function (data) {
        let mTime = null
        if (data.headers['last-modified'])
            mTime = parseInt(Date.parse(data.headers['last-modified']) / 1000)
        let localFileTime = null
        let stat = {}
        try {
            stat = fs.statSync(file)
            localFileTime = parseInt(Date.parse(stat['mtime']) / 1000)
        } catch (e) {

            if (program.verbose > 0)
                logger.log("[New File] Saving %s to %s of %s", url, file, _title.join(", "))
            if (program.debug)
                fs.appendFileSync("download.txt", util.format("%s\t%s\t%s\t%s\t%s\n", new Date().toISOString(), url, file, _title.join(", "), data.headers['content-length']))
            _save(url, file, Date.now() / 1000, mTime)
            return;
        }


        if ('size' in stat && stat['size'] != parseInt(data.headers['content-length'])) {
            if (program.verbose > 0)
                logger.log("[Wrong File Size] Saving %s to %s of %s, local %s vs remote %s", url, file, _title.join(", "), stat['size'], data.headers['content-length'])
            if (program.debug)
                fs.appendFileSync("download.txt", util.format("%s\t%s\t%s\t%s\t%s\t%s\n", new Date().toISOString(), url, file, _title.join(", "), stat['size'], data.headers['content-length']))
            _save(url, file, stat['atime'], mTime)
        } else {
            if (program.verbose > 1)
                logger.log("[File Exists] Skipping %s to %s of %s", url, file, _title.join(", "))
            if (program.debug)
                fs.appendFileSync("skipped.txt", util.format("%s\t%s\t%s\n", new Date().toISOString(), url, file))
            if (localFileTime !== null && mTime !== null && localFileTime != mTime) {
                if (program.verbose > 2) {
                    logger.log("[Fix Date] %s from %s to %s", file, localFileTime, mTime)
                    fs.appendFileSync("fix_date.txt", util.format("%s\t%s\t%s\t%s\t%s\n", new Date().toISOString(), url, file, localFileTime, mTime))
                }
                fs.utimesSync(file, new Date(), mTime)
            }
        }
    }, function (error) {
        logger.error(error)
    })
}