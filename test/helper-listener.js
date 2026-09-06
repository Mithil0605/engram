'use strict';

const net = require('net');
const s = net.createServer();
s.listen(0, '127.0.0.1', () => {
  console.log('p=' + s.address().port);
  setInterval(() => {}, 1000);
});