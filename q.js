const { Pool } = require('pg')
const fs = require('fs')
const pool = new Pool({ connectionString: fs.readFileSync('/tmp/.stagingdb','utf8').trim(), ssl: { rejectUnauthorized: false } })
;(async () => {
  const sql = process.argv.slice(2).join(' ')
  try { const r = await pool.query(sql); console.log(JSON.stringify(r.rows, null, 1)) }
  catch (e) { console.error('ERR:', e.message) }
  finally { await pool.end() }
})()
