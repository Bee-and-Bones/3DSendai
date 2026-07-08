// U7 (plan-004) — pairing URI parse/serialize + SD persistence. Pure C, no
// libctru; fully host-KAT'd by client/test/paircfg_test.c. See paircfg.h for
// the grammar. Style: bounded copies into fixed buffers, negative-int errors.

#include "paircfg.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

static const char SCHEME[] = "3dsendai://";

static int is_hex(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
static char to_lower_hex(char c) {
  return (c >= 'A' && c <= 'F') ? (char)(c - 'A' + 'a') : c;
}

int ab_paircfg_parse_uri(const char *uri, ab_paircfg *out) {
  if (!uri || !out) return -1;
  memset(out, 0, sizeof *out);
  if (strncmp(uri, SCHEME, sizeof SCHEME - 1) != 0) return -2;
  const char *p = uri + sizeof SCHEME - 1;

  // PSK: exactly 64 hex chars, ended by '@', '?', or end of string.
  int i = 0;
  for (; p[i] && p[i] != '@' && p[i] != '?'; i++) {
    if (i >= 64 || !is_hex(p[i])) return -3;
  }
  if (i != 64) return -3;
  for (int j = 0; j < 64; j++)
    out->psk_hex[j] = to_lower_hex(p[j]);
  out->psk_hex[64] = '\0';
  p += 64;

  // Optional @host:port.
  if (*p == '@') {
    p++;
    const char *colon = NULL;
    const char *q = p;
    for (; *q && *q != '?'; q++) {
      if (*q == ':') colon = q; // last colon wins (defensive; hosts are v4/names)
    }
    if (!colon || colon == p) goto bad_host;
    {
      size_t hlen = (size_t)(colon - p);
      if (hlen >= sizeof out->host) goto bad_host;
      memcpy(out->host, p, hlen);
      out->host[hlen] = '\0';
      long port = 0;
      const char *d = colon + 1;
      if (d == q) goto bad_host;
      for (; d < q; d++) {
        if (*d < '0' || *d > '9') goto bad_host;
        port = port * 10 + (*d - '0');
        if (port > 65535) goto bad_host;
      }
      if (port < 1) goto bad_host;
      out->port = (uint16_t)port;
    }
    p = q;
  }

  // Optional ?token=<non-empty>.
  if (*p == '?') {
    p++;
    if (strncmp(p, "token=", 6) != 0) goto bad_host;
    p += 6;
    size_t tlen = strlen(p);
    if (tlen == 0 || tlen >= sizeof out->token) goto bad_host;
    memcpy(out->token, p, tlen + 1);
    p += tlen;
  }
  if (*p != '\0') goto bad_host;
  return 0;

bad_host:
  memset(out, 0, sizeof *out);
  return -4;
}

int ab_paircfg_to_uri(const ab_paircfg *cfg, char *buf, uint32_t cap) {
  int n;
  if (cfg->host[0]) {
    n = snprintf(buf, cap, "%s%s@%s:%u%s%s", SCHEME, cfg->psk_hex, cfg->host, (unsigned)cfg->port,
                 cfg->token[0] ? "?token=" : "", cfg->token);
  } else {
    n = snprintf(buf, cap, "%s%s%s%s", SCHEME, cfg->psk_hex, cfg->token[0] ? "?token=" : "",
                 cfg->token);
  }
  if (n < 0 || (uint32_t)n >= cap) return -1;
  return n;
}

int ab_paircfg_load(const char *path, ab_paircfg *out) {
  FILE *f = fopen(path, "r");
  if (!f) return -1;
  char line[256];
  const char *got = fgets(line, sizeof line, f);
  fclose(f);
  if (!got) return -2;
  line[strcspn(line, "\r\n")] = '\0';
  return ab_paircfg_parse_uri(line, out) == 0 ? 0 : -3;
}

int ab_paircfg_save(const char *path, const ab_paircfg *cfg) {
  char uri[256];
  if (ab_paircfg_to_uri(cfg, uri, sizeof uri) < 0) return -1;

  FILE *f = fopen(path, "w");
  if (!f) {
    // Parent directory may not exist yet (sdmc:/3ds/3dsendai). Create the last
    // component and retry once; sdmc:/3ds always exists on a homebrew setup.
    char dir[128];
    size_t len = strlen(path);
    const char *slash = strrchr(path, '/');
    if (!slash || (size_t)(slash - path) >= sizeof dir || len >= sizeof dir) return -2;
    memcpy(dir, path, (size_t)(slash - path));
    dir[slash - path] = '\0';
    mkdir(dir, 0777); // EEXIST is fine; fopen below is the real check
    f = fopen(path, "w");
    if (!f) return -3;
  }
  int bad = fprintf(f, "%s\n", uri) < 0;
  if (fclose(f) != 0) bad = 1;
  return bad ? -4 : 0;
}
