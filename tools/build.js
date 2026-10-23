// Assemble index.html (the GitHub Pages site) and dist/regatta-lens.html (the Claude artifact version).
const fs = require('fs'), path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const sample = fs.readFileSync(path.join(__dirname, '../assets/sample.jpg')).toString('base64');
const pdf = fs.readFileSync(path.join(__dirname, '../regatta-markers.pdf')).toString('base64');
const fonts = 'https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=Big+Shoulders+Display:wght@700;800&family=IBM+Plex+Mono:wght@500&display=swap';
const head = `<title>Regatta Lens</title>
<meta name="claude:viewport-fit-sides" content="cover">
<meta name="description" content="AR move helper for the Regatta sailing board game">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fonts}">
<style>
${R('src/app.css')}
</style>`;
const ARUCO = ['https://cdn.jsdelivr.net/npm/js-aruco2@2.0.0/src/cv.js', 'https://cdn.jsdelivr.net/npm/js-aruco2@2.0.0/src/aruco.js'];
const body = `${R('src/app.html')}
${ARUCO.map((u) => `<script src="${u}"></script>`).join('\n')}
<script>window.REGATTA_SAMPLE = "data:image/jpeg;base64,${sample}";
window.REGATTA_MARKERS_PDF = "${pdf}";
window.REGATTA_ARUCO_URLS = ${JSON.stringify(ARUCO)};</script>
<script>
${R('src/engine.js')}
</script>
<script id="reader-src">
${R('src/reader.js')}
</script>
<script>
${R('src/app.js')}
</script>`;
fs.mkdirSync(path.join(__dirname, '../dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '../dist/regatta-lens.html'), head + '\n' + body + '\n');
const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
${head}
</head>
<body>
${body}
</body>
</html>
`;
fs.writeFileSync(path.join(__dirname, '../index.html'), standalone);
console.log('built', (Buffer.byteLength(head + body) / 1024).toFixed(0) + ' KB');
