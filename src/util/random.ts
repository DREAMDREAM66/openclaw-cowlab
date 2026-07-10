// SPDX-License-Identifier: MIT
// Originally from https://github.com/Tencent/openclaw-weixin
// Copyright (c) 2026 Tencent. Carried over verbatim from the upstream.

import crypto from "node:crypto";

/**
 * Generate a prefixed unique ID using timestamp + crypto random bytes.
 * Format: `{prefix}:{timestamp}-{8-char hex}`
 */
export function generateId(prefix: string): string {
  return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * Generate a temporary file name with random suffix.
 * Format: `{prefix}-{timestamp}-{8-char hex}{ext}`
 */
export function tempFileName(prefix: string, ext: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}
