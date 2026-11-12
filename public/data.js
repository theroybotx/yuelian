export const TODAY = '2026-10-31';
export const DEMO_TIME = 12 * 60;
export function freshData() {
  return {
    version: 1,
    students: [
      { id: 'roy', name: 'Roy', initial: 'R', color: 'sage', goal: '反手稳定性', last: '2026-10-24', note: '慢速来球能提前转肩，移动时还需要提醒。', next: '先复习提前转肩，再加入横向移动。' },
      { id: 'wang', name: '王以安', initial: '王', color: 'sand', goal: '发球与接发', last: '2026-10-31', note: '抛球位置更稳定，接发准备稍晚。', next: '接发启动与第一步。' },
      { id: 'chen', name: '陈一诺', initial: '陈', color: 'rose', goal: '底线多拍', last: '2026-10-25', note: '正手对拉节奏稳定。', next: '控制落点深度。' },
      { id: 'lin', name: '林小满', initial: '林', color: 'sky', goal: '入门基础', last: '2026-10-24', note: '能够连续完成五次慢速对拉。', next: '保持击球点在身体前方。' },
      { id: 'shen', name: '沈若溪', initial: '沈', color: 'sage', goal: '反手与步伐', last: '2026-09-30', note: '出差后再继续练习，暂未确定回来时间。', next: '复习双反击球节奏。' },
      { id: 'gu', name: '顾明远', initial: '顾', color: 'sand', goal: '小班对抗', last: '2026-10-25', note: '双打跑位需要继续巩固。', next: '网前交叉保护。' },
      { id: 'li', name: '李可', initial: '李', color: 'rose', goal: '正手与步伐', last: '2026-10-25', note: '落点控制有改善。', next: '移动中的平衡。' }
    ],
    venues: [
      { id: 'riverside', name: '滨江网球中心', address: '上海市浦东新区 · 滨江大道（示例地址）', court: '2 号场', indoor: false },
      { id: 'park', name: '城市公园网球场', address: '上海市浦东新区 · 公园路（示例地址）', court: '1 号场', indoor: false }
    ],
    lessons: [
      { id: 'l1', date: TODAY, start: 510, duration: 60, students: ['wang'], venue: 'riverside', type: '一对一', capacity: 1, state: 'done', note: '接发启动与第一步。' },
      { id: 'l2', date: TODAY, start: 600, duration: 90, students: ['roy'], venue: 'riverside', type: '一对一', capacity: 1, state: 'confirmed', note: '反手提前转肩，加入移动练习。' },
      { id: 'l3', date: TODAY, start: 840, duration: 90, students: ['chen', 'gu', 'li'], venue: 'riverside', type: '小班课', capacity: 4, state: 'confirmed', note: '底线多拍与双打跑位。' },
      { id: 'l4', date: TODAY, start: 990, duration: 60, students: ['lin'], venue: 'park', type: '一对一', capacity: 1, state: 'confirmed', note: '正手击球点与慢速对拉。' },
      { id: 'l5', date: '2026-11-03', start: 1140, duration: 60, students: ['roy'], venue: 'riverside', type: '一对一', capacity: 1, state: 'pending', note: 'Roy 提交的预约申请。' }
    ],
    ledger: [
      { id: 'r-buy', student: 'roy', date: '2026-10-01', delta: 10, label: '购买课时包', detail: '10 课时 · 教练登记' },
      { id: 'r-1', student: 'roy', date: '2026-10-10', delta: -1.5, label: '一对一 · 90 分钟', detail: '滨江网球中心 · 已到课' },
      { id: 'r-2', student: 'roy', date: '2026-10-17', delta: -1.5, label: '一对一 · 90 分钟', detail: '滨江网球中心 · 已到课' },
      { id: 'r-3', student: 'roy', date: '2026-10-24', delta: -1.5, label: '一对一 · 90 分钟', detail: '滨江网球中心 · 已到课' },
      ...[['wang', 10, 6], ['chen', 10, 3], ['lin', 5, 3.5], ['shen', 10, 2.5], ['gu', 10, 4], ['li', 10, 5]].flatMap(([student, bought, used]) => [
        { id: `${student}-buy`, student, date: '2026-09-01', delta: bought, label: '购买课时包', detail: `${bought} 课时 · 教练登记` },
        { id: `${student}-used`, student, date: student === 'shen' ? '2026-09-30' : '2026-10-25', delta: -used, label: '历史已上课程', detail: '原型合并展示的历史消课' }
      ])
    ],
    notes: [
      { id: 'n1', student: 'roy', date: '2026-10-24', topic: '反手 · 提前转肩', observation: '慢速来球时，能更早完成转肩；移动后击球还是偏晚。', next: '先复习提前转肩，再加入横向移动。', feedback: '这次慢速反手更从容了。下次继续保持提前转肩，再试着把它带进移动击球。', published: true },
      { id: 'n2', student: 'roy', date: '2026-10-17', topic: '反手 · 击球位置', observation: '原地击球能找到身体前方的位置，连续多拍时容易后退。', next: '用慢速连续喂球巩固转肩时机。', feedback: '今天找到了更舒服的击球位置。练习时先保持慢节奏，注意身体前方的击球点。', published: true },
      { id: 'n3', student: 'roy', date: '2026-10-10', topic: '反手 · 动作建立', observation: '理解双反握拍和转肩，需要减少手臂单独发力。', next: '建立转肩带动挥拍的感觉。', feedback: '今天从握拍和转肩开始。下次先复习动作，再加入连续击球。', published: true }
    ],
    messages: [
      { id: 'm-book', kind: 'booking', student: 'roy', lesson: 'l5', title: '下周二，想再练一节', text: '教练，下周二晚上七点有空吗？还是滨江，一小时。', state: 'pending', date: '今天 11:42' },
      { id: 'm-balance', kind: 'balance', student: 'roy', title: '想核对一下剩余课时', text: '我记得还剩六课时，能帮我看一下最近的消课记录吗？', state: 'pending', date: '今天 09:18' },
      { id: 'm-note', kind: 'feedback', student: 'roy', title: '10 月 24 日 · 课后反馈', text: '这次慢速反手更从容了。下次继续保持提前转肩，再试着把它带进移动击球。', state: 'done', date: '10 月 24 日', note: 'n1' }
    ],
    settings: { travel: 40, days: ['二', '三', '四', '五', '六', '日'], start: '08:00', end: '21:00', assistantCanEdit: true },
    studentPractice: [],
    followups: []
  };
}
export const balanceOf = (data, id) => data.ledger.filter(e => e.student === id).reduce((sum, e) => sum + e.delta, 0);
export const timeText = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export const dateText = date => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8, 10))} 日`;
export const durationText = minutes => minutes % 60 ? `${Math.floor(minutes / 60) ? `${Math.floor(minutes / 60)} 小时 ` : ''}${minutes % 60} 分钟` : `${minutes / 60} 小时`;
export const moneyless = n => Number(n.toFixed(2)).toString();
const initial = freshData();
console.assert(initial.lessons.filter(l => l.date === TODAY).reduce((sum, l) => sum + l.duration, 0) === 300, '今日课程合计应为 300 分钟');
console.assert(balanceOf(initial, 'roy') === 5.5, 'Roy 的余额应为 5.5 课时');
