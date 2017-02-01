'use strict'

var Promise = require("bluebird")
var mkdirp = require("mkdirp")
var fs = require("fs")
var path = require("path")
var Url = require("url")
var cheerio = require("cheerio")
var request = require('request-defaults');
var unique = require('array-unique');
var program = require('commander');
var process = require('process');
var sanitize = require("sanitize-filename");

var main = {
    chinese: 'http://www.gld.gov.hk/egazette/tc_chi/gazette/toc.php',
    english: 'http://www.gld.gov.hk/egazette/english/gazette/toc.php'
}

var baseRequest

program
    .version('0.0.1')
    .usage('[options] <no of page>')
    .option('-o, --output <path>', 'Output directory')
    .option('-l, --language <language>', 'Language (chinese or english)', /^(chinese|english)$/, 'chinese')
    .option('-y, --year <year, ...>', 'Download only issue published in specific year(s) (e.g. "-y 2012-2013,2015,2016-" )', numberList)
    .option('-l, --volume <volume, ...>', 'Download only specific volume(s), same syntax as --year', numberList)
    .option('-u, --no <volume number, ...>', 'Download only specific volume numbers(s), same syntax as --year', numberList)
    .option('-s, --search <keywords or regular expression>', 'Download only volumes with title contains <keywords> or match <regular expression>', "")
    .option('-g, --gazette-type <volume type, ...>', 'Download only specific type of volume(s) (0=General Issue, 1=Extraordinary Issue)', numberList)
    .option('-n, --notice-type <notice type, ...>', 'Download only specific notice(s) (0=Government Notice,1=Supplement 1,...)', numberList)
    .option('-w, --wait <time in ms>', 'Wait between each wave of pdf download, default is 500ms', parseInt, 500)
    .option('-m, --max-connection <max connection>', 'Maximum simultaneous HTTP connections, default is 4', parseInt, 4)
    .option('-t, --timeout <time in ms>', 'Timeout for each HTTP request, default is 5000ms', parseInt, 5000)
    .option('-v, --verbose', 'Be more verbose', increaseVerbosity, 0)
    .action(function(noOfPage) {
        baseRequest = request.defaults({
            pool: {
                maxSockets: program.maxConnection
            },
            timeout: program.timeout
        })

        let re = isRegExp(program.search)
        if (re)
            program.search = new RegExp(re[0], re[1])
        noOfPage = noOfPage || 5
        getToc(main[program.language], [], noOfPage)
    })
    .parse(process.argv);
program.output = program.output || process.cwd()

function increaseVerbosity(v, total) {
    return total + 1;
}

function pushUnique(arr, val) {
    if (Array.isArray(arr) && arr.indexOf(val) == -1)
        arr.push(val)
    return arr
}

function isRegExp(val) {
    let matches = val.match(/^\/(.+)\/(\w+)?$/)
    if (matches) {
        matches[2] = matches[2] || ""
        return matches.splice(1)
    }
    return null
}

function numberList(val) {
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

    return unique(tmp2);
}

function getToc(nextPage, volumes_url, max_volumes) {
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
            });

            let next = $("img[name=nextBtn]").parent()
            if (next.length && max_volumes > 1) {
                return getToc(Url.resolve(nextPage, next[0].attribs['href']), volumes_url, --max_volumes)
            } else {
                if (program.verbose > 3)
                    console.dir("Nos of links found: " + volumes_url.length)
                return getVolumes(unique(volumes_url), [])
            }
        } else {
            console.log(error)
        }
    })
}

function getVolumes(volumes_url, titles) {
    let requests = []
    let downloaded_pdf = []
    for (let i in volumes_url) {
        let url = volumes_url[i]
        let title = []
        if (Array.isArray(titles) && i in titles)
            title = titles[i]
        requests.push((function(_url, _title) {
            return baseRequest.get(_url, function(error, response, body) {
                let new_volumes_url = []
                let new_titles = []
                if (!error && response.statusCode == 200) {
                    if (program.verbose > 3) console.log("Downloading " + _url + " success!")
                    let $ = cheerio.load(body)

                    $("a[href^='?year=']").each(function() {
                        if (program.verbose > 3) console.dir("148: getVolumes(): " + Url.resolve(_url, this.attribs['href']))
                        let uri = Url.parse(this.attribs['href'], {
                            parseQueryString: true
                        })
                        if (!program.noticeType || program.noticeType.indexOf(parseInt(uri.query.type)) != -1) {
                            let new_url = Url.resolve(_url, this.attribs['href'])
                            new_volumes_url.push(new_url)
                            let t = _title.splice()
                            t.push($(this).text().trim())
                            new_titles.push(t)
                        }
                    });
                    $("a[href$='.pdf']").each(function() {
                        let absolute_url = Url.resolve(_url, this.attribs['href'])
                        if (program.verbose > 3) console.dir("161: getVolumes(): " + absolute_url)
                        let full_title = _title.join(", ") + ", " + $(this).text().trim()
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
                                if (name_suffix != "--" && (!fs.existsSync(output_pathname) || fs.statSync(output_pathname)["size"] == 0)) {
                                    mkdirp.sync(path_parts['dir'])
                                    if (program.verbose > 0)
                                        console.log("Saving " + absolute_url + " to " + output_pathname + " of " + _title.join(", "))

                                    setTimeout(function() {
                                        return baseRequest.get(absolute_url).on('error', function(err) {
                                            console.error(err)
                                        }).pipe(fs.createWriteStream(output_pathname))
                                    }, program.wait)

                                } else {
                                    downloaded_pdf.push(absolute_url)
                                    if (program.verbose > 1)
                                        console.log("[File Exists] Skipping " + absolute_url + " to " + output_pathname + " of " + _title.join(", "))
                                }
                            } else {
                                if (program.verbose > 1)
                                    console.log("[Text Unmatched] Skipping " + absolute_url + " to " + output_pathname + " of " + _title.join(", ") + " because of unmatchedd search filter")

                            }
                        }
                    })
                    if (new_volumes_url.length) {
                        let [u, t] = unique2(new_volumes_url, new_titles)
                        return getVolumes(u, t)
                    }
                } else {
                    console.error("Downloading " + url + " with text " + _title.join(", ") + " failed")
                    console.error(error)
                }

            })
        })(url, title))
    }
}

function unique2(arr, arr2) {
    if (!Array.isArray(arr) || !Array.isArray(arr2)) {
        throw new TypeError('array-unique expects an array.');
    }

    if (arr.length != arr2.length) {
        throw new TypeError('array-unique expects two array should be the same size.');
    }

    var len = arr.length;
    var i = -1;

    while (i++ < len) {
        var j = i + 1;

        for (; j < arr.length; ++j) {
            if (arr[i] === arr[j]) {
                arr.splice(j--, 1);
                arr2.splice(j--, 1);
            }
        }
    }
    return [arr, arr2];
};
