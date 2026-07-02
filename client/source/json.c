#include "json.h"

#include <string.h>

// Locate the value string for "key" and copy it out, unescaping the common
// JSON escapes the host emits (\" \\ \/ \n \r \t). Assumes the value is a
// string (starts with a quote after the colon), which holds for our payloads.
bool json_get_string(const char *json, const char *key, char *out, size_t outsize) {
  if (outsize == 0) return false;
  out[0] = '\0';

  // Build the search needle: "key"
  char needle[64];
  size_t klen = strlen(key);
  if (klen + 3 >= sizeof(needle)) return false;
  needle[0] = '"';
  memcpy(needle + 1, key, klen);
  needle[1 + klen] = '"';
  needle[2 + klen] = '\0';

  const char *p = strstr(json, needle);
  if (!p) return false;
  p += strlen(needle);
  while (*p == ' ' || *p == ':') p++;
  if (*p != '"') return false;
  p++; // skip opening quote

  size_t o = 0;
  while (*p && *p != '"' && o + 1 < outsize) {
    if (*p == '\\' && p[1]) {
      p++;
      switch (*p) {
        case 'n': out[o++] = '\n'; break;
        case 'r': out[o++] = '\r'; break;
        case 't': out[o++] = '\t'; break;
        case '"': out[o++] = '"'; break;
        case '\\': out[o++] = '\\'; break;
        case '/': out[o++] = '/'; break;
        default: out[o++] = *p; break; // \uXXXX and others passed through crudely
      }
      p++;
    } else {
      out[o++] = *p++;
    }
  }
  out[o] = '\0';
  return true;
}

void json_escape_string(const char *in, char *out, size_t outsize) {
  size_t o = 0;
  for (const char *p = in; *p && o + 2 < outsize; p++) {
    switch (*p) {
      case '"': out[o++] = '\\'; out[o++] = '"'; break;
      case '\\': out[o++] = '\\'; out[o++] = '\\'; break;
      case '\n': out[o++] = '\\'; out[o++] = 'n'; break;
      case '\r': out[o++] = '\\'; out[o++] = 'r'; break;
      case '\t': out[o++] = '\\'; out[o++] = 't'; break;
      default: out[o++] = *p; break;
    }
  }
  out[o] = '\0';
}

static int hex_nibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

size_t ab_hex_decode(const char *hex, size_t hexlen, uint8_t *out, size_t outcap) {
  size_t o = 0;
  for (size_t i = 0; i + 1 < hexlen && o < outcap; i += 2) {
    int hi = hex_nibble(hex[i]);
    int lo = hex_nibble(hex[i + 1]);
    if (hi < 0 || lo < 0) break; // stop at the first non-hex character
    out[o++] = (uint8_t)((hi << 4) | lo);
  }
  return o;
}
