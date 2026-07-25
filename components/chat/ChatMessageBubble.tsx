"use client";

import { useState } from "react";
import type { SearchResultItem } from "@/components/search/SearchResultCard";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SearchResultItem[];
}

interface ChatMessageBubbleProps {
  message: ChatMessage;
}

export function ChatMessageBubble({ message }: ChatMessageBubbleProps) {
  const [showSources, setShowSources] = useState(false);
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
          isUser
            ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
            : "border border-zinc-200 bg-white text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
        }`}
      >
        <p className="whitespace-pre-line">{message.content}</p>

        {!isUser && message.sources && message.sources.length > 0 && (
          <div className="mt-2 border-t border-zinc-100 pt-2 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => setShowSources((v) => !v)}
              className="text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            >
              {showSources ? "Hide sources" : `Sources (${message.sources.length})`}
            </button>

            {showSources && (
              <ul className="mt-2 space-y-1">
                {message.sources.map((source, index) => (
                  <li
                    key={`${source.chunkId ?? source.invoiceId}-${index}`}
                    className="rounded-md bg-zinc-50 px-2 py-1 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                  >
                    {source.invoice?.invoiceNumber ?? `Invoice ${index + 1}`}
                    {source.invoice?.vendorName ? ` — ${source.invoice.vendorName}` : ""}
                    <span className="ml-1 text-zinc-400 dark:text-zinc-500">
                      ({(source.score * 100).toFixed(1)}% match)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
