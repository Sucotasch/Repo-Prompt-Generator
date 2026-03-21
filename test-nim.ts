import fetch from "node-fetch";

async function test() {
  try {
    const response = await fetch('https://integrate.api.nvidia.com/v1/models', {
      headers: {
        'Authorization': 'Bearer test',
        'HTTP-Referer': 'https://ais-dev.run.app',
        'X-Title': 'AI Studio Applet',
      }
    });
    console.log(response.status);
    const text = await response.text();
    console.log(text.substring(0, 100));
  } catch (e) {
    console.error(e.message);
  }
}
test();
