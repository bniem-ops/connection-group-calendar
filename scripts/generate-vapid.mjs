// Generates a VAPID keypair for Web Push and writes SECRETS.local.txt (gitignored).
import webpush from "web-push";
import { writeFileSync } from "node:fs";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

const body = `VAPID keys for Group Calendar - generated ${new Date().toISOString()}
DO NOT COMMIT THIS FILE.

1) Put the PUBLIC key in public/config.js:
     export const VAPID_PUBLIC_KEY = "${publicKey}";

2) Add these as GitHub repository secrets (Settings > Secrets and variables > Actions):
     VAPID_PUBLIC_KEY   = ${publicKey}
     VAPID_PRIVATE_KEY  = ${privateKey}
     VAPID_SUBJECT      = mailto:youremail@example.com

3) For local testing, also copy them into .env.local (see .env.example).

Public key:
${publicKey}

Private key:
${privateKey}
`;

writeFileSync(new URL("../SECRETS.local.txt", import.meta.url), body);
console.log(body);
console.log("Written to SECRETS.local.txt");
