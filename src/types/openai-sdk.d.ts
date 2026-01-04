declare module "openai" {
  export interface ChatCompletionMessageParam {
    role: "system" | "user" | "assistant";
    content: string;
  }

  export interface ChatCompletionChoice {
    message?: { content?: string | null };
  }

  export interface ChatCompletionsCreateParams {
    model: string;
    messages: ChatCompletionMessageParam[];
    response_format?: unknown;
    temperature?: number;
  }

  export interface ChatCompletionResponse {
    id: string;
    choices: ChatCompletionChoice[];
  }

  export default class OpenAI {
    constructor(config: { apiKey: string });
    chat: {
      completions: {
        create: (params: ChatCompletionsCreateParams) => Promise<ChatCompletionResponse>;
      };
    };
  }
}
