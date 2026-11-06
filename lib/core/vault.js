// 超级管理员钥匙：一把 X25519 私钥，和这份记忆一一对应（双向映射）。
//
//  - 模型第一次写记忆时，在你的电脑上生成它，放到桌面。数据目录里只留下公钥和私钥所在的路径。
//  - 写入像往邮筒投信：每段记忆用一次性密钥和公钥协商出 AES-256-GCM 密钥来加密，所以写入不需要私钥。
//  - 读取（AI 回想、在星环里看、导出）每次都要去那个路径读私钥：钥匙在就自动解锁，不在谁都打不开。
//  - 这把私钥是唯一的，丢了就再也打不开这份记忆。
import crypto from 'node:crypto'

const b64 = buf => Buffer.from(buf).toString('base64')
const unb64 = s => Buffer.from(s, 'base64')
const INFO = Buffer.from('forget-me-not/v2')

export function fingerprint(publicB64) {
  const h = crypto.createHash('sha256').update(unb64(publicB64)).digest('hex').toUpperCase()
  return h.slice(0, 16).match(/.{4}/g).join('-')
}

/** 生成超级管理员钥匙：返回要写到桌面的文件内容，以及要留在数据目录里的公钥。 */
export function newAdminKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  const pub = b64(publicKey.export({ type: 'spki', format: 'der' }))
  const fp = fingerprint(pub)
  const file = [
    '勿忘我 · Forget-me-not —— 超级管理员钥匙',
    '',
    '这是 TA 的记忆唯一的钥匙，和这份记忆一一对应。',
    '回想、查看、修改、删除、导出记忆，都需要它在下面登记的位置。',
    '它只有这一份：丢了就再也打不开这份记忆，谁也无法重新生成。',
    '请马上备份到安全的地方（U 盘、密码管理器），不要发给任何人，也不要交给 AI。',
    '挪了位置的话：打开记忆星环，点右下角的小钥匙，填上新路径。',
    '',
    `指纹：${fp}`,
    `生成时间：${new Date().toISOString()}`,
    '',
    privateKey.export({ type: 'pkcs8', format: 'pem' }).trim(),
    '',
  ].join('\n')
  return { file, publicKey: pub, fingerprint: fp }
}

/** 从钥匙文件的文本里取出私钥；必须和公钥配对，否则返回 null。 */
export function loadPrivateKey(text, publicB64) {
  const m = String(text || '').match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/)
  if (!m) return null
  try {
    const priv = crypto.createPrivateKey(m[0])
    if (priv.asymmetricKeyType !== 'x25519') return null
    const pub = b64(crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }))
    if (pub.length !== publicB64.length || !crypto.timingSafeEqual(Buffer.from(pub), Buffer.from(publicB64))) return null
    return priv
  } catch { return null }
}

export function publicKeyOf(publicB64) {
  return crypto.createPublicKey({ key: unb64(publicB64), format: 'der', type: 'spki' })
}

function derive(shared, epk, aad) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, epk, Buffer.concat([INFO, aad]), 32))
}

/** 用公钥封存（Buffer 或可 JSON 化的值）。aad 把密文和记忆 id 绑在一起，防止挪用和篡改。 */
export function seal(publicKey, value, aad = '') {
  const plain = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8')
  const eph = crypto.generateKeyPairSync('x25519')
  const epk = eph.publicKey.export({ type: 'spki', format: 'der' })
  const a = Buffer.from(String(aad))
  const key = derive(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey }), epk, a)
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(a)
  const data = Buffer.concat([c.update(plain), c.final()])
  return { epk: b64(epk), iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) }
}

/** 用私钥打开。asJson=false 时返回 Buffer。 */
export function open(privateKey, box, aad = '', asJson = true) {
  const epk = unb64(box.epk)
  const a = Buffer.from(String(aad))
  const shared = crypto.diffieHellman({ privateKey, publicKey: crypto.createPublicKey({ key: epk, format: 'der', type: 'spki' }) })
  const d = crypto.createDecipheriv('aes-256-gcm', derive(shared, epk, a), unb64(box.iv))
  d.setAAD(a)
  d.setAuthTag(unb64(box.tag))
  const plain = Buffer.concat([d.update(unb64(box.data)), d.final()])
  return asJson ? JSON.parse(plain.toString('utf8')) : plain
}
