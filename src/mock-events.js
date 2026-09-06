function randomItem(items) { return items[Math.floor(Math.random() * items.length)]; }
function makeMockCode(account) {
  const device = randomItem(['Telegram for Android', 'Telegram for iOS', 'Telegram Desktop', 'Telegram Web', 'Unknown external device']);
  return {
    id: `code_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    accountId: account.id,
    code: String(Math.floor(10000 + Math.random() * 90000)),
    device,
    deviceDetail: device === 'Unknown external device' ? 'Exact requesting device not confirmed' : 'Mock request metadata',
    location: `${account.region || 'Unknown'}, ${account.country || 'Unknown'}`,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(),
    status: 'NEW',
    simulated: true
  };
}
module.exports = { makeMockCode };
