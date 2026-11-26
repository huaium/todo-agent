export const taskMethods = ["manual", "due", "priority", "effort", "title"] as const;
export const binMethods = ["deleted", "title"] as const;
export const sortLabels = {
  manual: "手动排序",
  due: "截止时间",
  priority: "优先级",
  effort: "工作量",
  title: "标题",
  deleted: "删除时间",
};
export const directionLabels = {
  manual: [],
  due: ["最早优先", "最晚优先"],
  priority: ["高优先", "低优先"],
  effort: ["小优先", "大优先"],
  title: ["标题正序", "标题倒序"],
  deleted: ["最近删除优先", "最早删除优先"],
};
