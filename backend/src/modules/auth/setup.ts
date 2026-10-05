import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hashPassword } from './password.js';

const path = '.env';
let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
if (/^ADMIN_PASSWORD_HASH=.+/m.test(content) && !process.argv.includes('--reset')) {
  console.log('Hesap zaten kurulmuş. Şifreyi yenilemek için --reset kullanın.');
  process.exit(0);
}
const username = process.env.MSO_SETUP_USERNAME || 'admin';
if (!/^[a-zA-Z0-9_.-]{3,50}$/.test(username)) throw new Error('Kullanıcı adı 3–50 harf, rakam, nokta, tire veya alt çizgi içermeli.');
const password = randomBytes(18).toString('base64url');
const hash = await hashPassword(password);
for (const [key, value] of Object.entries({ ADMIN_USERNAME: username, ADMIN_PASSWORD_HASH: hash })) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  content = pattern.test(content) ? content.replace(pattern, `${key}=${value}`) : `${content.trimEnd()}\n${key}=${value}\n`;
}
writeFileSync(path, content);
writeFileSync('../GIRIS-BILGILERI.local.txt', `MSO Teknoloji\nKullanıcı adı: ${username}\nGeçici şifre: ${password}\n\nGiriş: http://localhost:5173\nŞifreyi yenile: backend klasöründe npm run auth:setup -- --reset\nBu dosya kişisel giriş bilgilerinizi içerir; paylaşmayın.\n`, { mode: 0o600 });
console.log('Hesap oluşturuldu. Giriş bilgileri: GIRIS-BILGILERI.local.txt. API sunucusunu yeniden başlatın.');
