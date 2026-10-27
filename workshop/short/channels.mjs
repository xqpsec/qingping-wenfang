// channels.mjs —— 短篇投稿渠道规格表（工坊短篇模块的「先选渠道、再按规格出稿」）
// 来源：公开的约稿渠道与保底平台调研整理（2026-10-04，不随仓库提供）
// 证据等级：A=平台原文；B=可查第三方；C=自媒体/未核验。价格与邮箱会变，界面上一律附「先核实」提示。
//
// 字段：
//   range   该渠道可收的字数（硬边界）    sweet  我们出稿瞄准的区间（交付闸门用这个）
//   tone    oh-story 平台基调：知乎盐选 / 小程序 / 番茄短篇（决定视角、烈度、章末落点、结局质感）
//   marker  小节标记：chapter=###第N章  numeric=###N.  zhihu=N.     quote  ascii="" / yan=「」
//   exclusive  该渠道是否明文要求独家首发/禁止一稿多投（true=明文；null=未找到条款）
export const CHANNELS = {
  'fanqie-jinpin': {
    name: '番茄短故事 · IP 金品共创（中短）', range: [20001, 80000], sweet: [20500, 24000], tone: '番茄短篇', marker: 'chapter', quote: 'ascii',
    price: '中短 100–700+ 元/千字（活动价）', deadline: '2026-10-31', contact: 'contact@example.com（公共邮箱，勿与责编重复投）',
    exclusive: true, evidence: 'A（番茄征稿页）', genres: '男频/女频脑洞、玄幻仙侠、现言甜宠、历史古代、都市日常、宫斗宅斗、古风世情、年代、婚姻家庭、女生生活、男生生活',
    note: '明文要求独家首发、禁止一稿多投；投出即锁定这篇稿。',
  },
  'fanqie-short': {
    name: '番茄短故事 · 千字万金（超短）', range: [8000, 24900], sweet: [10000, 12500], tone: '番茄短篇', marker: 'chapter', quote: 'ascii',
    price: '超短 80–500+ 元/千字（活动价）', deadline: '2026-11-30', contact: 'contact@example.com',
    exclusive: true, evidence: 'A（番茄征稿页）', note: '明文要求独家首发、禁止一稿多投。',
  },
  'xiaochengxu': {
    name: '小程序短篇（投稿168 等编辑直投，九州/磨铁等）', range: [8000, 20000], sweet: [9500, 12000], tone: '小程序', marker: 'numeric', quote: 'ascii',
    price: '新人行情千字 30–50 元，单篇 300–500 元；九州保底千字 30 起/买断 50 起', contact: '投稿168 编辑库筛「小程序风 / 短篇 1 万字左右」',
    exclusive: null, evidence: 'B（九州公告、投稿168 首页）', note: '收稿量最大、打脸爽文为主力；各编辑是否允许多投以编辑说明为准。',
  },
  'yanxuan': {
    name: '知乎盐言故事', range: [8000, 100000], sweet: [9500, 12000], tone: '知乎盐选', marker: 'zhihu', quote: 'yan',
    price: '新手 80–150 元/千字（C）', contact: '盐言故事创作者后台', exclusive: null, evidence: 'B/C', note: '审核约 20 个工作日，最慢；重细节拼图、余韵。',
  },
  'heiyan': {
    name: '黑岩故事会', range: [8000, 20000], sweet: [9000, 12000], tone: '小程序', marker: 'numeric', quote: 'ascii',
    price: '分成或保底（金额未公开）', contact: '黑岩作者后台/编辑', exclusive: null, evidence: 'C', note: '一句一段、多留白。',
  },
  'meitian': {
    name: '每天读点故事', range: [5000, 8000], sweet: [6000, 7800], tone: '小程序', marker: 'numeric', quote: 'ascii',
    price: '传 VIP 保底 1000 元/篇（C，未核实）', contact: '先由真人打开官方征稿页核实', exclusive: null, evidence: 'C', note: '证据只有二手帖，投前必须核实。',
  },
}

export const GENRES = ['世情打脸', '复仇打脸', '追妻火葬场', '总裁豪门', '宅斗宫斗', '甜宠', '悬疑', '民俗怪谈', '沙雕脑洞', '双男主']

export function channel(id) {
  const c = CHANNELS[id]
  if (!c) throw new Error(`没有这个投稿渠道：${id}（可选：${Object.keys(CHANNELS).join('、')}）`)
  return { id, ...c }
}

export const markerText = (c, n) => (c.marker === 'chapter' ? `###第${n}章` : c.marker === 'zhihu' ? `${n}.` : `###${n}.`)
