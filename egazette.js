'use strict'

var Promise = require("bluebird")
var mkdirp = require("mkdirp")
var fs = require('graceful-fs')
var path = require("path")
var Url = require("url")
var cheerio = require("cheerio")
var request = require('requestretry')
var unique = require('array-unique')
var program = require('commander')
var process = require('process')
var sanitize = require("sanitize-filename")

var main = {
    chinese: 'http://www.gld.gov.hk/egazette/tc_chi/gazette/toc.php',
    english: 'http://www.gld.gov.hk/egazette/english/gazette/toc.php'
}

var baseRequest
var noOfPages

program
    .version('0.0.1')
    .usage('[options] <no of pages>')
    .option('-o, --output <path>', 'Output directory')
    .option('-l, --language <language>', 'Language (chinese or english)', /^(chinese|english)$/, 'chinese')
    .option('-y, --year <year, ...>', 'Download only issue published in specific year(s) (e.g. "-y 2012-2013,2015,2016-" )', yearList)
    .option('-l, --volume <volume, ...>', 'Download only specific volume(s) (e.g. "-v 1-2,5,9" )', numberList)
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
    .option('-v, --verbose', 'Be more verbose (max -vvvv)', increaseVerbosity, 0)
    .arguments('<no of pages>')
    .action(function(_noOfPages) {
        baseRequest = request.defaults({
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

        program.output = program.output || process.cwd()
        if (program.export)
            program.export = path.join(program.output, program.export)

        let re = isRegExp(program.search)
        if (re)
            program.search = new RegExp(re[0], re[1])

        noOfPages = parseInt(_noOfPages)
        if (noOfPages)
            getToc(main[program.language], [], _noOfPages).then(getVolumes).catch(function(err) {
                console.error(err)
            }).finally(removeDupe)
        else {
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
                console.log("Removing duplicate links...")
                let rows = fs.readFileSync(program.export, {
                    encoding: "utf8"
                }).split("\n")
                rows = unique(rows)
                fs.writeFileSync(program.export, rows.join("\n"))
            }
            console.log("All done!")
        })
    } else
        console.log("All done!")
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

function getToc(nextPage, volumes_url, max_volumes) {
    console.log("Parsing TOC..")
    return new Promise(function(resolve, reject) {
        function get(nextPage, volumes_url, max_volumes) {
            return baseRequest.get(nextPage, function(error, response, body) {
                if (!error && response.statusCode == 200) {
                    let $ = cheerio.load(body)
                    if (program.verbose > 2)
                        console.dir("Parsing: " + nextPage)
                    $("a[href^='volume.php']").each(function() {
                        let uri = Url.parse(this.attribs['href'], {
                            parseQueryString: true
                        })

                        if (!program.gazetteType || program.gazetteType.indexOf(parseInt(uri.query.extra)) != -1)
                            if (!program.year || program.year.indexOf(parseInt(uri.query.year)) != -1)
                                if (!program.volume || program.volume.indexOf(parseInt(uri.query.volume)) != -1)
                                    if (!program.no || program.no.indexOf(parseInt(uri.query.no)) != -1)
                                        pushUnique(volumes_url, Url.resolve(nextPage, this.attribs['href']))
                    })

                    let next = $("img[name=nextBtn]").parent()
                    if (next.length && max_volumes > 1) {
                        return get(Url.resolve(nextPage, next[0].attribs['href']), volumes_url, --max_volumes)
                    } else {
                        volumes_url = unique(volumes_url)
                        console.log("done! %d links found", volumes_url.length)
                        resolve(volumes_url)
                    }
                } else {
                    reject(error)
                }
            })
        }
        get(nextPage, volumes_url, max_volumes)

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

function getVolumes(volume_urls) {
    return new Promise(function(resolve, reject) {
        function get(volume_urls, volume_titles, pdf_urls, pdf_titles) {
            if (!Array.isArray(volume_titles))
                volume_titles = []

            resize(volume_titles, volume_urls.length, [])

            let requests = []
            let downloaded_pdf = []

            for (let i in volume_urls) {
                let url = volume_urls[i]
                let title = volume_titles[i]

                requests.push((function(_url, _title) {
                    return function() {

                        baseRequest.get(_url, function(error, response, body) {

                            let new_volumes_url = []
                            let new_titles = []
                            if (!error && response.statusCode == 200) {
                                if (program.verbose > 3) console.log("Downloading " + _url + " success!")
                                let $ = cheerio.load(body)
                                let x = parseUrls($, _url, _title)
                                new_volumes_url = x[0], new_titles = x[1]

                                let requests = []
                                $("a[href$='.pdf']").each(function() {
                                    let absolute_url = Url.resolve(_url, this.attribs['href'])

                                    if (program.verbose > 3) console.dir("getVolumes(): URL found: " + absolute_url)
                                    let full_title = _title.join(", ") + ", " + $(this).text().trim()
                                    if (program.export)
                                        fs.appendFileSync(program.export, [absolute_url].concat(_title).concat([$(this).text().trim()]).join("\t") + "\n")
                                    if (!program.noDownload) {
                                        if (downloaded_pdf.indexOf(absolute_url) == -1 && !$(this).text().match(/^\d+$/) && !$(this).text() != "--") {

                                            let url_parts = Url.parse(absolute_url)
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

                                                    requests.push((function(absolute_url, output_pathname, _title) {
                                                        return function() {
                                                            return save(absolute_url, output_pathname, _title)
                                                        }
                                                    })(absolute_url, output_pathname, _title))

                                                    downloaded_pdf.push(absolute_url)
                                                }
                                            } else {
                                                if (program.verbose > 1)
                                                    console.log("[Text Unmatched] Skipping " + absolute_url + " to " + output_pathname + " of " + _title.join(", ") + " because of unmatchedd search filter")

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
                                console.error("Downloading " + url + " with text " + _title.join(", ") + " failed")
                                if (!error)
                                    console.log(response);
                                else
                                    console.error(error)
                            }

                        })
                    }
                })(url, title))
            }
            run(requests)
        }
        get(volume_urls)
    })
}

function run(requests) {
    if (requests.length > 0) {
        let request = requests.shift()
        request()
        if (requests.length > 0) {
            setTimeout(function() {
                run(requests)
            }, program.wait)
        }
    }
}

function parseUrls($, url, title) {
    let new_volumes_url = [],
        new_titles = []

    $("a[href^='?year=']").each(function() {
        if (program.verbose > 3) console.dir("getVolumes(): URL found: " + Url.resolve(url, this.attribs['href']))
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
    let fileStream = fs.createWriteStream(file).on('finish', function() {
        if (program.verbose > 2)
            console.log("[Fix Date] %s to %s", file, mTime)
        fs.utimesSync(file, aTime, mTime)
    })
    return baseRequest.get(url).pipe(fileStream)

}

function save(url, file, _title) {
    return baseRequest.head(url).then(function(data) {
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
                console.log("[New File] Saving " + url + " to " + file + " of " + _title.join(", "))
            _save(url, file, new Date(), mTime)
            return;
        }


        if ('size' in stat && stat['size'] != parseInt(data.headers['content-length'])) {
            if (program.verbose > 0)
                console.log("[Wrong File Size] Saving " + url + " to " + file + " of " + _title.join(", ") + " local %s vs remote %s", stat['size'], data.headers['content-length'])
            _save(url, file, stat['atime'], mTime)
        } else {
            if (program.verbose > 1)
                console.log("[File Exists] Skipping " + url + " to " + file + " of " + _title.join(", "))
            if (localFileTime !== null && mTime !== null && localFileTime != mTime) {
                if (program.verbose > 2)
                    console.log("[Fix Date] %s from %s to %s", file, localFileTime, mTime)
                fs.utimesSync(file, new Date(), mTime)
            }
        }
    }, function(error) {
        console.error(error)
    })
}
