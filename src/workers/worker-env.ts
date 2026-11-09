/**
 * Which environment variables may be inherited by an executor.
 *
 * An executor needs its model credentials to function, and nothing else. Tool
 * credentials — cloud keys, source-host tokens, database passwords — must never
 * be handed to a process whose behavior is decided by a model reading text that
 * an outsider may have influenced. The CLI workers are gone, but the rule still
 * guards any future executor and the environment it is given.
 *
 * 执行者可以继承哪些环境变量。
 *
 * 执行者需要模型凭据才能工作，除此之外不需要任何东西。工具类凭据——云密钥、代码托管 token、
 * 数据库密码——绝不能交给一个"行为由读着可能被外部影响过的文本的模型决定"的进程。CLI Worker
 * 已移除，但这条规则仍守护任何未来的执行者及其被赋予的环境。
 */
const MODEL_PREFIXES = ["ANTHROPIC_", "OPENAI_", "GEMINI_", "OPENROUTER_", "DEEPSEEK_", "XAI_", "MISTRAL_", "CLAUDE_", "CODEX_", "PI_", "MAGPIE_"];
const FORBIDDEN_PREFIXES = [
  "AWS_", "GITHUB_", "GH_", "GITLAB_", "SLACK_", "STRIPE_", "AZURE_", "GCP_", "GOOGLE_APPLICATION",
  "DATABASE_", "DB_", "POSTGRES", "MYSQL", "REDIS", "SMTP_", "TWILIO_", "SENDGRID_", "SSH_", "OPENSSH_",
];
const FORBIDDEN_SUFFIX = /(_TOKEN|_SECRET|_PASSWORD|_PASSWD|_PRIVATE_KEY|_API_KEY|_ACCESS_KEY)$/i;

/** Throws when an executor declares an environment variable it must not see. 当执行者声明了它不应看到的环境变量时抛出。 */
export function assertWorkerEnvName(name: string): void {
  const upper = name.toUpperCase().replace(/\*+$/, "");
  if (MODEL_PREFIXES.some((prefix) => upper.startsWith(prefix))) return;
  if (FORBIDDEN_PREFIXES.some((prefix) => upper.startsWith(prefix)) || FORBIDDEN_SUFFIX.test(upper)) {
    throw new Error(
      `A worker may not inherit ${name}. Workers receive model credentials only; `
      + "tool credentials belong behind the credential broker, not in a worker's environment. "
      + `Worker 不得继承 ${name}。Worker 只接收模型凭据；工具凭据应放在凭据代管之后，而不是 Worker 的环境变量里。`,
    );
  }
}
