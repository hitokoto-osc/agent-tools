import type { LanguageModel } from "ai";
import { defaultModel } from "./model.js";
import { webFetch, type WebFetchOptions } from "./tools/web-fetch.js";
import { webSearch, type WebSearchOptions } from "./tools/web-search.js";

export interface AgentToolsOptions {
  model?: LanguageModel;
}

export class AgentTools {
  private _model: LanguageModel | undefined;

  constructor(options: AgentToolsOptions = {}) {
    this._model = options.model;
  }

  get model(): LanguageModel {
    if (!this._model) {
      this._model = defaultModel();
    }
    return this._model;
  }

  webFetch(options: Omit<WebFetchOptions, "model"> = {}) {
    return webFetch({ ...options, model: this.model });
  }

  webSearch(options: Omit<WebSearchOptions, "model">) {
    return webSearch({ ...options, model: this.model });
  }
}
