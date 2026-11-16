import { readFileSync, writeFileSync } from 'node:fs'

// Windows PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI, which mangles
// Chinese literals. Make sure every shipped .ps1 carries a BOM.
for (const file of process.argv.slice(2)) {
  const text = readFileSync(file)
  if (text[0] === 0xef && text[1] === 0xbb && text[2] === 0xbf) {
    console.log(`ok (already has BOM): ${file}`)
    continue
  }
  writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), text]))
  console.log(`added BOM: ${file}`)
}
