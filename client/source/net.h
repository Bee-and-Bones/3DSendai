// AgentBus network layer for the 3DS client (soc:U over WiFi).
// COMPILES with devkitPro; runtime UNVERIFIED without hardware.
#ifndef SENDAI_NET_H
#define SENDAI_NET_H

#include <3ds.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
  uint8_t type;
  uint32_t session_id;
  const char *payload; // NUL-terminated JSON (valid until next ab_net_poll)
  size_t payload_len;
} ab_frame;

// Initialize soc:U once (page-aligned buffer). Returns 0 on success.
int ab_net_init(void);

// Configure the transport PSK once at startup. NULL/empty hex leaves the
// plaintext mode active; 64 hex chars enables sealed frames (nonce|ct|mac
// records with a u32 BE outer length, epoch read on connect). Returns 0 on
// success, -1 on malformed hex (transport stays plaintext).
int ab_net_set_psk(const char *hex);

// Open a socket to host:port. Retryable — call again after a disconnect.
// Returns 0 on success, negative on error.
int ab_net_connect(const char *host, uint16_t port);

// Close the current socket (keeps soc:U initialized for reconnect).
void ab_net_disconnect(void);

// Tear down soc:U and free the buffer (call at exit).
void ab_net_shutdown(void);

bool ab_net_connected(void);

// Send a framed message. Returns 0 on success, negative on error (caller may
// treat an error as a disconnect and reconnect).
int ab_net_send(uint8_t type, uint32_t session_id, const char *payload_json);

// Convenience: ATTACH with the pairing token.
int ab_net_attach(const char *token);

// U34: send raw key bytes to a session as a KEYSTROKE frame ({sessionId, hex}).
// `bytes`/`len` are hex-encoded into the JSON payload (matching TERMINAL_DATA's
// hex convention). Returns 0 on success, negative on error. A len of 0 is a
// no-op success.
int ab_net_send_keys(uint32_t session_id, const uint8_t *bytes, size_t len);

// U11: send captured PCM16 bytes as an AUDIO_CHUNK frame
// ({sessionId, hex, final}). `final` marks the end of a push-to-talk
// utterance; a final chunk may carry zero bytes. Returns 0 on success.
int ab_net_send_audio(uint32_t session_id, const uint8_t *bytes, size_t len, bool final);

// Non-blocking: read available bytes, decode frames, invoke cb for each.
// Returns the number of frames dispatched, or -1 if the connection dropped.
int ab_net_poll(void (*cb)(const ab_frame *frame, void *ud), void *ud);

// Zero-config discovery (U27, requires a PSK): broadcast one encrypted probe
// on udp/discovery_port and wait briefly (bounded, ~500ms) for a host reply.
// On success writes the host's dotted-quad into out_ip and its TCP port into
// out_port and returns 0; -1 on timeout/no PSK/error. Call from the reconnect
// loop — each reconnect tick is one probe round, so retry comes for free.
int ab_net_discover(uint16_t discovery_port, char *out_ip, size_t out_ip_len, uint16_t *out_port);

#endif // SENDAI_NET_H
