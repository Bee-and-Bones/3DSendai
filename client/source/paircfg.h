// U7 (plan-004) — SD-persisted pairing config. Pure C (no libctru): the URI
// parser/serializer and file load/save use only stdio, so the whole module
// host-compiles for client/test/paircfg_test.c. On device the path is
// sdmc:/3ds/3dsendai/pair.cfg (newlib's sdmc devoptab makes fopen work).
//
// URI grammar (shared fixture with host/src/pair.ts):
//   3dsendai://<psk64hex>[@<host>:<port>][?token=<token>]
// Host/port optional — without them the device relies on encrypted discovery.
#ifndef SENDAI_PAIRCFG_H
#define SENDAI_PAIRCFG_H

#include <stdint.h>

#define AB_PAIRCFG_PATH "sdmc:/3ds/3dsendai/pair.cfg"

typedef struct {
  char psk_hex[65]; // 64 lowercase hex chars + NUL (always set when valid)
  char host[64];    // empty = discovery only
  uint16_t port;    // 0 when host is empty
  char token[64];   // empty = none
} ab_paircfg;

// Parse a pairing URI into `out`. Returns 0 on success, negative on any
// malformation (wrong scheme, psk not 64 hex chars, bad port, empty token).
// `out` is zeroed first and only written fully on success.
int ab_paircfg_parse_uri(const char *uri, ab_paircfg *out);

// Serialize back to the URI form (what pair.cfg stores, verbatim).
// Returns the length written, or negative if `cap` is too small.
int ab_paircfg_to_uri(const ab_paircfg *cfg, char *buf, uint32_t cap);

// Load + parse `path`. Returns 0 on success; negative when the file is
// absent/unreadable/invalid (caller falls back to compile-time config.h).
int ab_paircfg_load(const char *path, ab_paircfg *out);

// Serialize + write `path` (creating the parent directory if needed).
// Returns 0 on success, negative on I/O failure.
int ab_paircfg_save(const char *path, const ab_paircfg *cfg);

#endif // SENDAI_PAIRCFG_H
