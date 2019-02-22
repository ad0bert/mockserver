/**
 * @author Peter Ortner
 */

const http = require('http');
const fs = require('fs');

const hostname = '127.0.0.1';

if (process.argv.length !== 6 || process.argv[2] !== '-p' || process.argv[4] !== '-m') {
    console.log("Usage: " + __filename + " -p PORT -m PATH");
    process.exit(-1);
}

const port = process.argv[3];
const mockPath = '/' + process.argv[5];

const server = http.createServer((req, res) => {
    const fileContent = getFileContent(req.url, req.method);

    if (fileContent) {
        const lines = fileContent.split(/\r?\n/g);
        // SET HTTP STATUS
        res.statusCode = parseInt(lines[0].split(/\s+/g)[1]);
        let lineCnt = 1;
        // SET HTTP HEADERS
        for (let i = 1; i < lines.length && !lines[i].startsWith('{'); ++i) {
            if (lines[i].trim() === '') continue;
            const headerLine = lines[i].split(':');
            res.setHeader(headerLine[0].trim(), headerLine[1].trim());
            lineCnt++;
        }
        // BUILD RESPONSE CONTENT
        for (let i = lineCnt; i < lines.length; ++i) {
            res.write(lines[i]);
        }
    } else {
        res.statusCode = 404;
    }
    res.end();
});

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});

function getFileContent(path, type) {
    console.info('\x1b[34m', type + ' - HTTP Call for: ' + path);
    let pathParam = '';
    if (path.includes('?')) {
        pathParam = '--' + path.split('?')[1];
        path = path.split('?')[0];
    }
    if (type === 'OPTIONS') {
        pathParam = '';
    }
    let filePath = __dirname + mockPath + path + '/' + type + pathParam + '.mock';
    if (!fs.existsSync(filePath)) {
        console.warn('\x1b[33m', 'NOT FOUND: ' + filePath);
        console.warn('\x1b[33m', '    --> check for wildcards ...');
        const filePathParts = filePath.split('/');
        let currPathToCheck = filePathParts[0];
        for (let i = 1; i < filePathParts.length - 1; ++i) {
            const checkNext = currPathToCheck + '/' + filePathParts[i];
            if (fs.existsSync(checkNext)) {
                currPathToCheck = checkNext;
            } else {
                currPathToCheck += '/__';
                if (!fs.existsSync(currPathToCheck)) {
                    console.error('\x1b[31m', 'NOT FOUND: ' + currPathToCheck);
                    return null;
                }
            }
        }
        filePath = currPathToCheck + '/' + filePathParts[filePathParts.length - 1];
        if (!fs.existsSync(filePath)) {
            console.error('\x1b[31m', 'NOT FOUND: ' + filePath);
            return null;
        }
    }
    console.info('\x1b[32m', 'FILE FOUND: ' + filePath);
    return fs.readFileSync(filePath).toString();
}
