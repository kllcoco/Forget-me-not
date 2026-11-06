// 封存保险库：像往邮筒投信一样——谁都能投（用公钥加密写入），只有拿钥匙的人能打开（私钥被超级管理员密码锁着）。
//
//  - 设定密码时生成一对 X25519 密钥；私钥用 scrypt(密码) 派生的密钥 + AES-256-GCM 加密后存盘，明文私钥从不落盘。
//  - 每段记忆用一把一次性的临时密钥和公钥协商出 AES 密钥来加密：写入不需要密码。
//  - 读取（回想、在星环里查看）需要私钥，也就是需要超级管理员先输入密码「唤醒」。
import crypto from 'node:crypto'

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const INFO = Buffer.from('forget-me-not/v1')

const b64 = buf => Buffer.from(buf).toString('base64')
const unb64 = s => Buffer.from(s, 'base64')

function kek(password, salt, params = SCRYPT) {
  return crypto.scryptSync(String(password).normalize('NFKC'), salt, 32, params)
}

function aesSeal(key, plain, aad) {
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  if (aad) c.setAAD(aad)
  const data = Buffer.concat([c.update(plain), c.final()])
  return { iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) }
}

function aesOpen(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, unb64(box.iv))
  if (aad) d.setAAD(aad)
  d.setAuthTag(unb64(box.tag))
  return Buffer.concat([d.update(unb64(box.data)), d.final()])
}

/** 第一次设定超级管理员密码：返回要写进 vault.json 的内容和解开的私钥。 */
export function createVault(password) {
  if (!password || String(password).length < 8) throw new Error('超级管理员密码至少 8 位')
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const salt = crypto.randomBytes(16)
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' })
  const record = {
    v: 1,
    kdf: { name: 'scrypt', salt: b64(salt), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    publicKey: b64(publicKey.export({ type: 'spki', format: 'der' })),
    privateKey: aesSeal(kek(password, salt), priv, Buffer.from('vault')),
    created_at: Date.now() / 1000,
  }
  return { record, privateKey }
}

/** 用密码打开私钥；密码错误会抛出错误。 */
export function openVault(record, password) {
  const { kdf } = record
  const key = kek(password, unb64(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT.maxmem })
  let der
  try { der = aesOpen(key, record.privateKey, Buffer.from('vault')) } catch { throw Object.assign(new Error('密码不对'), { code: 'BAD_PASSWORD' }) }
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
}

/** 换密码：私钥不变，只是换一把锁。 */
export function rewrapVault(record, privateKey, newPassword) {
  if (!newPassword || String(newPassword).length < 8) throw new Error('超级管理员密码至少 8 位')
  const salt = crypto.randomBytes(16)
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' })
  return { ...record, kdf: { name: 'scrypt', salt: b64(salt), N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    privateKey: aesSeal(kek(newPassword, salt), priv, Buffer.from('vault')) }
}

export function publicKeyOf(record) {
  return crypto.createPublicKey({ key: unb64(record.publicKey), format: 'der', type: 'spki' })
}

function derive(shared, epkRaw, aad) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, epkRaw, Buffer.concat([INFO, aad || Buffer.alloc(0)]), 32))
}

/** 用公钥封存一段数据（Buffer 或可 JSON 化的对象），aad 用来把密文和记忆 id 绑在一起。 */
export function seal(publicKey, value, aad = '') {
  const plain = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8')
  const eph = crypto.generateKeyPairSync('x25519')
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' })
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey })
  const a = Buffer.from(String(aad))
  return { epk: b64(epk), ...aesSeal(derive(shared, epk, a), plain, a) }
}

/** 用私钥打开封存的数据。asJson=false 时返回 Buffer。 */
export function open(privateKey, box, aad = '', asJson = true) {
  const epk = unb64(box.epk)
  const shared = crypto.diffieHellman({ privateKey, publicKey: crypto.createPublicKey({ key: epk, format: 'der', type: 'spki' }) })
  const a = Buffer.from(String(aad))
  const plain = aesOpen(derive(shared, epk, a), box, a)
  return asJson ? JSON.parse(plain.toString('utf8')) : plain
}
