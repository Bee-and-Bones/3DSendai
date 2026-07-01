// Minimal JSON string helpers for the 3DS client. Enough for AgentBus's
// controlled, canonical-JSON payloads — NOT a general parser. A fuller build
// should vendor cJSON (as rAI3DS does).
#ifndef AG3NT_JSON_H
#define AG3NT_JSON_H

#include <stdbool.h>
#include <stddef.h>

// Find "key":"..." in `json` and copy the unescaped string value into `out`
// (NUL-terminated, bounded by outsize). Returns false if the key is absent.
bool json_get_string(const char *json, const char *key, char *out, size_t outsize);

// Escape `in` into `out` as a JSON string body (no surrounding quotes),
// NUL-terminated and bounded by outsize.
void json_escape_string(const char *in, char *out, size_t outsize);

#endif // AG3NT_JSON_H
