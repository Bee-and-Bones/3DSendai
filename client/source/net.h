// AgentBus network layer for the 3DS client (soc:U over WiFi).
// COMPILES with devkitPro; runtime UNVERIFIED without hardware.
#ifndef AG3NT_NET_H
#define AG3NT_NET_H

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

// Non-blocking: read available bytes, decode frames, invoke cb for each.
// Returns the number of frames dispatched, or -1 if the connection dropped.
int ab_net_poll(void (*cb)(const ab_frame *frame, void *ud), void *ud);

#endif // AG3NT_NET_H
