const http = require('http');
const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/auth/login',
  method: 'POST',
  headers: { 'Content-Type': 'application/json' }
}, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    const token = JSON.parse(body).token;
    console.log("Token:", token);
    const req2 = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/auth/profile',
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res2) => {
      let body2 = '';
      res2.on('data', d => body2 += d);
      res2.on('end', () => console.log("Profile:", body2));
    });
    req2.end();
  });
});
req.write(JSON.stringify({ identifier: 'shalakaindunil@gmail.com', password: 'password123' })); // Adjust based on seed data
req.end();
