import type { BulkPreview, CreatedTask, TaskCard } from "../shared/chat.ts";
import { cardTask } from "./chat-card.ts";
import { deadlineQuestion, type QuestionResult } from "./chat-questions.ts";
import type { TaskStore } from "./task-store.ts";

type Reply = QuestionResult & { preview?: BulkPreview | null };
type Options = {
  interactive?: boolean;
  interrupted?: boolean;
  message?: string;
};

export class ChatCapture {
  private readonly created = new Map<string, boolean>();
  private readonly fields = new Map<string, object>();
  private readonly cards: TaskCard[] = [];
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
  hasSourceQuote(quote?: string) {
    return !!quote?.trim() && this.source.includes(quote.trim());
  }
  record(id: string, deadlineOptOutQuote?: string, fields: object = {}) {
    this.created.set(id, this.hasSourceQuote(deadlineOptOutQuote));
    this.fields.set(id, fields);
  }
  add(card: TaskCard) {
    this.cards.push(card);
  }

  finish(store: TaskStore, result: Reply, options: Options = {}): Reply {
    const reply = this.receipt(store, result, options);
    const cards: TaskCard[] = [];
    const tasks = Array.from(this.created.keys()).flatMap((id) => {
      const [task] = store.search({ id }, 0, 1);
      return task ? [cardTask(store, task, this.fields.get(id))] : [];
    });
    if (tasks.length) cards.push({ kind: "created", tasks });
    cards.push(...this.cards, ...(result.presentation?.cards ?? []));
    const note = options.interrupted
      ? result.reply
      : (options.message ?? result.presentation?.note);
    if (options.message) reply.reply = [reply.reply, options.message].filter(Boolean).join("\n");
    if (!cards.length) return reply;
    return { ...reply, presentation: { cards, ...(note && { note }) } };
  }

  private receipt(store: TaskStore, result: Reply, options: Options): Reply {
    if (options.interrupted || this.created.size >= 2) {
      const createdTasks: CreatedTask[] = [];
      for (const id of this.created.keys()) {
        const [task] = store.search({ id }, 0, 1);
        if (task)
          createdTasks.push({
            id,
            title: task.title,
            dueDate: task.dueDate ?? null,
            dueTime: task.dueTime ?? null,
          });
      }
      if (createdTasks.length === 0) return result;
      if (createdTasks.length === 1) {
        if (!options.interrupted) return result;
        return { ...result, reply: `已添加「${createdTasks[0].title}」。\n${result.reply}` };
      }
      const timed = createdTasks.filter((t) => t.dueTime).length;
      const undated = createdTasks.filter((t) => !t.dueDate).length;
      const dateOnly = createdTasks.length - timed - undated;
      const counts = [
        timed && `${timed} 项有具体时间`,
        dateOnly && `${dateOnly} 项仅设日期`,
        undated && `${undated} 项未设日期`,
      ].filter(Boolean);
      const summary = `已添加 ${createdTasks.length} 项任务。${counts.join("，")}。`;
      const reply =
        options.interrupted || result.question || result.preview
          ? summary + "\n" + result.reply
          : summary;
      return { ...result, reply, createdTasks };
    }
    if (!options.interactive || result.question || result.preview) return result;
    for (const [id, skip] of this.created) {
      if (skip) break;
      const question = deadlineQuestion(store.taskContext(id), id);
      if (question?.kind === "deadline") {
        const { title, dueDate, list } = question.task;
        const reply = dueDate
          ? `已记下「${title}」，${dueDate} 到期。要设具体时间吗？`
          : `已把「${title}」加入${list}。什么时候需要完成？`;
        return {
          ...result,
          reply,
          question,
        };
      }
    }
    return result;
  }
}
