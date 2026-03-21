async function test() {
  const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'OPTIONS',
    headers: {
      'Origin': 'https://example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  });
  console.log('STATUS:', res.status);
  const headers = {};
  res.headers.forEach((v, k) => headers[k] = v);
  console.log('HEADERS:', JSON.stringify(headers, null, 2));
}
test();
