const { Client } = require('ssh2');

const conn = new Client();
conn.on('ready', () => {
  console.log('✅ Berhasil Terhubung ke RDP!');
  conn.exec('dir', (err, stream) => {
    if (err) throw err;
    stream.on('close', (code, signal) => {
      conn.end();
    }).on('data', (data) => {
      console.log('OUTPUT: ' + data);
    }).stderr.on('data', (data) => {
      console.log('STDERR: ' + data);
    });
  });
}).connect({
  host: '8.215.23.248',
  port: 22,
  username: 'Administrator',
  password: 'Subarya123'
});
