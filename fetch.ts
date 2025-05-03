export const headers = {
  accept: "*/*",
  "accept-language":
    "en-US,en;q=0.9,ru;q=0.8,tr;q=0.7,hr;q=0.6,az;q=0.5,sr;q=0.4",
  authorization: `Bearer ${process.env.TOKEN}`,
  priority: "u=1, i",
  "sec-ch-ua":
    '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
  "sec-ch-ua-arch": '"x86"',
  "sec-ch-ua-bitness": '"64"',
  "sec-ch-ua-full-version": '"135.0.7049.115"',
  "sec-ch-ua-full-version-list":
    '"Google Chrome";v="135.0.7049.115", "Not-A.Brand";v="8.0.0.0", "Chromium";v="135.0.7049.115"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-model": '""',
  "sec-ch-ua-platform": '"Windows"',
  "sec-ch-ua-platform-version": '"15.0.0"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  cookie: process.env.COOKIE!,
  Referer: "https://sora.com",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
