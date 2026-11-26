/**
 * The owner's answer to a question the Main Agent is blocked on.
 *
 * A model question written in prose is easy to miss and cannot be answered with
 * one click. This broker lets the model *call* for a decision: the turn stops at
 * the tool call, the question and its 2–4 choices appear in the chat, and the
 * owner's click resolves the promise the tool is waiting on. The model receives
 * the choice as the tool result and continues in the same turn — the shape
 * Claude Code and Codex use for a confirmation prompt.
 *
 * The list is in memory on purpose: it belongs to a live turn. If the daemon
 * restarts, the turn is gone too, so a persisted question would outlive the
 * only thing that could consume its answer. The dashboard reads `list()` on
 * every poll, so a UI reload re-renders an unanswered question; the turn keeps
 * waiting.
 *
 * 所有者对 Main Agent 阻塞问题的回答。
 *
 * 写在正文里的模型提问容易被漏掉，也无法一键作答。这个经纪人让模型"调用"一个决定：回合停在
 * 工具调用上，问题与 2–4 个选项出现在对话里，所有者的点击解析工具正在等待的 Promise。模型把
 * 选择作为工具结果收到，并在同一回合继续——这正是 Claude Code 与 Codex 的确认提示形态。
 *
 * 列表刻意放在内存：它属于一个活着的回合。守护进程重启后回合也没了，持久化的问题会比唯一能
 * 消费答案的东西活得更久。Dashboard 每次轮询都读 `list()`，因此 UI 刷新会重新渲染未回答的
 * 问题，回合继续等待。
 */
import { randomUUID } from "node:crypto";

export interface OwnerQuestionChoice {
  id: string;
  label: string;
  description?: string;
}

export interface OwnerQuestionInput {
  conversationId: string;
  turnId?: string;
  question: string;
  choices: Array<{ label: string; description?: string }>;
  allowOther?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PendingOwnerQuestion {
  id: string;
  conversationId: string;
  turnId?: string;
  question: string;
  choices: OwnerQuestionChoice[];
  allowOther: boolean;
  createdAt: string;
}

export interface OwnerAnswer {
  questionId: string;
  choiceId?: string;
  label?: string;
  text?: string;
  cancelled?: boolean;
  timedOut?: boolean;
}

const QUESTION_LIMIT = 500;
const LABEL_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;
const MIN_CHOICES = 2;
const MAX_CHOICES = 4;
/** A turn must not wait forever if the app is closed. 应用关闭时回合不能永远等待。 */
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

interface PendingEntry {
  question: PendingOwnerQuestion;
  resolve: (answer: OwnerAnswer) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class OwnerQuestionBroker {
  readonly #pending = new Map<string, PendingEntry>();

  /** Ask and wait for the owner. Resolves with a choice, free text, or a stop. 提问并等待所有者；以选项、自由文本或停止结束。 */
  ask(input: OwnerQuestionInput): Promise<OwnerAnswer> {
    const conversationId = input.conversationId.trim();
    if (conversationId.length === 0) throw new Error("A question needs a conversation id.");
    const question = input.question.trim();
    if (question.length === 0) throw new Error("A question is required.");
    if (question.length > QUESTION_LIMIT) throw new Error(`A question must be at most ${QUESTION_LIMIT} characters.`);
    if (input.choices.length < MIN_CHOICES || input.choices.length > MAX_CHOICES) {
      throw new Error(`A question needs between ${MIN_CHOICES} and ${MAX_CHOICES} choices.`);
    }
    const labels = new Set<string>();
    const choices: OwnerQuestionChoice[] = input.choices.map((choice, index) => {
      const label = choice.label.trim();
      if (label.length === 0) throw new Error(`Choice ${index + 1} needs a label.`);
      if (label.length > LABEL_LIMIT) throw new Error(`Choice ${index + 1} is longer than ${LABEL_LIMIT} characters.`);
      if (labels.has(label)) throw new Error(`Choice ${index + 1} repeats "${label}".`);
      labels.add(label);
      const description = typeof choice.description === "string" ? choice.description.trim() : "";
      if (description.length > DESCRIPTION_LIMIT) throw new Error(`Choice ${index + 1} has a description longer than ${DESCRIPTION_LIMIT} characters.`);
      return {
        id: `choice-${index + 1}`,
        label,
        ...(description.length === 0 ? {} : { description }),
      };
    });
    const id = `question-${randomUUID()}`;
    const pending: PendingOwnerQuestion = {
      id,
      conversationId,
      ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
      question,
      choices,
      allowOther: input.allowOther !== false,
      createdAt: new Date().toISOString(),
    };
    return new Promise<OwnerAnswer>((resolve) => {
      if (input.signal?.aborted === true) {
        resolve({ questionId: id, cancelled: true });
        return;
      }
      const timer = setTimeout(() => this.#settle(id, { questionId: id, timedOut: true }), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref?.();
      const onAbort = () => this.#settle(id, { questionId: id, cancelled: true });
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(id, {
        question: pending,
        resolve,
        timer,
        ...(input.signal === undefined ? {} : { signal: input.signal, onAbort }),
      });
    });
  }

  /** Every question still blocking a turn. 仍在阻塞回合的问题。 */
  list(): PendingOwnerQuestion[] {
    return [...this.#pending.values()].map((entry) => ({
      ...entry.question,
      choices: entry.question.choices.map((choice) => ({ ...choice })),
    }));
  }

  /**
   * Answer one question. Throws for an unknown choice or an empty answer; a
   * second answer for the same id returns undefined (the question is gone).
   * 回答一个问题。未知选项或空答案抛错；同一 id 的第二次回答返回 undefined（问题已结束）。
   */
  answer(id: string, input: { choiceId?: string; text?: string }): PendingOwnerQuestion | undefined {
    const entry = this.#pending.get(id);
    if (entry === undefined) return undefined;
    if (typeof input.choiceId === "string" && input.choiceId.length > 0) {
      const choice = entry.question.choices.find((candidate) => candidate.id === input.choiceId);
      if (choice === undefined) throw new Error(`"${input.choiceId}" is not a choice of this question.`);
      this.#settle(id, { questionId: id, choiceId: choice.id, label: choice.label });
      return entry.question;
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (text.length === 0) throw new Error("An answer needs a choiceId or text.");
    if (text.length > QUESTION_LIMIT) throw new Error(`An answer must be at most ${QUESTION_LIMIT} characters.`);
    this.#settle(id, { questionId: id, text });
    return entry.question;
  }

  /** Resolve every waiting question, so a shutdown cannot strand a turn. 解析所有等待中的问题，使关停不会搁置回合。 */
  closeAll(): void {
    for (const id of [...this.#pending.keys()]) this.#settle(id, { questionId: id, cancelled: true });
  }

  #settle(id: string, answer: OwnerAnswer): void {
    const entry = this.#pending.get(id);
    if (entry === undefined) return;
    this.#pending.delete(id);
    clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.onAbort !== undefined) entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(answer);
  }
}

/** What the model sees as the tool result. 模型看到的工具结果。 */
export function formatOwnerAnswer(answer: OwnerAnswer): string {
  if (answer.cancelled === true) return "The owner stopped this turn before answering; do not continue with this decision.";
  if (answer.timedOut === true) return "The owner did not answer within 30 minutes. Stop this branch and ask again later rather than assuming a choice.";
  if (answer.text !== undefined && answer.text.length > 0) return `The owner answered: ${answer.text}`;
  return `The owner chose: ${answer.label ?? answer.choiceId ?? "(unknown)"}`;
}