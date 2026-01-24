const http = require('http');

const options = {
    hostname: 'localhost',
    port: 4600,
    path: '/admin/media',
    method: 'GET',
    headers: {
        'x-admin-id': '00000000-0000-0000-0000-000000000001'
    }
};

const req = http.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => {
        data += chunk;
    });
    res.on('end', () => {
        console.log(data);
    });
});

req.on('error', (e) => {
    console.error(`problem with request: ${e.message}`);
});

req.end();
