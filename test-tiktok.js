const tiktok = require('@faouzkk/tiktok-dl');
async function test() {
    const url = "https://www.tiktok.com/@tiktok/video/7106594312292453678";
    try {
        const res = await tiktok(url);
        console.log("Success:", JSON.stringify(res, null, 2).substring(0,500));
    } catch(e) {
        console.log("Error:", e.message);
    }
}
test();
