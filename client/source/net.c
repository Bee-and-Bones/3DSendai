// AgentBus network layer (soc:U). COMPILES; runtime UNVERIFIED without hardware.
// Frame: [u32 length BE][u8 type][u32 session_id BE][json payload].
// With a PSK set (ab_net_set_psk), every frame is sealed: the host sends an
// 8-byte cleartext epoch on connect, then both directions carry
// [u32 record BE][nonce(24)|ct|mac(16)] where the record plaintext is the
// frame above. Counters and epoch reset per connection.
// soc:U is initialized once; the socket can be reconnected across drops/sleeps.

#include "crypto.h"
#include "net.h"
#include "protocol.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <malloc.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define SOC_ALIGN 0x1000
#define SOC_BUFFERSIZE 0x100000 // 1 MiB, page-aligned (libctru convention)
#define RXBUF 0x4000
#define EPOCH_TIMEOUT_MS 3000 // budget for the 8-byte epoch read on connect
// Largest plaintext frame that fits one sealed record within RXBUF:
// outer u32(4) + nonce|mac overhead(40) + plaintext.
#define MAX_PLAIN_FRAME (RXBUF - AB_FRAME_OVERHEAD - 4)

static u32 *s_soc_buf = NULL;
static bool s_soc_ready = false;
static bool s_ps_ready = false; // ps:ps RNG for nonces (needed only with a PSK)
static int s_sock = -1;
static uint8_t s_rx[RXBUF];
static size_t s_rx_len = 0;

static uint8_t s_psk[AGENTBUS_KEY_BYTES];
static bool s_psk_active = false;
static uint64_t s_epoch = 0;    // host-minted per connection, cleartext on connect
static uint64_t s_send_seq = 0; // per-direction AAD counters, reset per connection
static uint64_t s_recv_seq = 0;

int ab_net_init(void) {
  if (s_soc_ready) return 0;
  s_soc_buf = (u32 *)memalign(SOC_ALIGN, SOC_BUFFERSIZE);
  if (!s_soc_buf) return -1;
  if (R_FAILED(socInit(s_soc_buf, SOC_BUFFERSIZE))) return -2;
  s_soc_ready = true;
  s_ps_ready = R_SUCCEEDED(psInit()); // sealed sends fail cleanly if unavailable
  return 0;
}

int ab_net_set_psk(const char *hex) {
  s_psk_active = false;
  if (!hex || hex[0] == '\0') return 0; // plaintext mode
  if (ab_key_from_hex(hex, s_psk) != 0) return -1;
  s_psk_active = true;
  return 0;
}

static int fill_random(uint8_t *out, size_t len) {
  if (!s_ps_ready) return -1;
  return R_FAILED(PS_GenerateRandomBytes(out, len)) ? -1 : 0;
}

// Blocking-with-budget read on the non-blocking socket (epoch handshake only).
// Returns 0 once len bytes arrived, -1 on close/error/timeout.
static int recv_exact(uint8_t *buf, size_t len, int budget_ms) {
  size_t off = 0;
  int waited = 0;
  while (off < len) {
    ssize_t n = recv(s_sock, buf + off, len - off, 0);
    if (n == 0) return -1; // peer closed
    if (n < 0) {
      if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
      if (++waited > budget_ms) return -1; // dead host: don't hang the UI
      svcSleepThread(1000000LL);           // 1 ms
      continue;
    }
    off += (size_t)n;
  }
  return 0;
}

int ab_net_connect(const char *host, uint16_t port) {
  if (!s_soc_ready) return -1;
  ab_net_disconnect();
  s_rx_len = 0;

  s_sock = socket(AF_INET, SOCK_STREAM, 0);
  if (s_sock < 0) return -3;

  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  addr.sin_addr.s_addr = inet_addr(host);
  if (connect(s_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
    closesocket(s_sock);
    s_sock = -1;
    return -4;
  }
  fcntl(s_sock, F_SETFL, fcntl(s_sock, F_GETFL, 0) | O_NONBLOCK);

  if (s_psk_active) { // host sends the cleartext epoch first
    uint8_t eb[AGENTBUS_EPOCH_BYTES];
    if (recv_exact(eb, sizeof(eb), EPOCH_TIMEOUT_MS) != 0) {
      ab_net_disconnect();
      return -5;
    }
    for (size_t i = 0; i < sizeof(eb); i++) s_epoch = (s_epoch << 8) | eb[i];
  }
  return 0;
}

void ab_net_disconnect(void) {
  if (s_sock >= 0) {
    closesocket(s_sock);
    s_sock = -1;
  }
  s_rx_len = 0;
  s_epoch = 0;
  s_send_seq = 0;
  s_recv_seq = 0;
}

void ab_net_shutdown(void) {
  ab_net_disconnect();
  if (s_ps_ready) {
    psExit();
    s_ps_ready = false;
  }
  if (s_soc_ready) {
    socExit();
    s_soc_ready = false;
  }
  if (s_soc_buf) {
    free(s_soc_buf);
    s_soc_buf = NULL;
  }
}

bool ab_net_connected(void) { return s_sock >= 0; }

static int send_all(const uint8_t *buf, size_t len) {
  size_t off = 0;
  while (off < len) {
    ssize_t n = send(s_sock, buf + off, len - off, 0);
    if (n < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK) continue; // busy-wait send (M1)
      return -1;
    }
    if (n == 0) return -1;
    off += (size_t)n;
  }
  return 0;
}

// Seal one plaintext frame and send it as [u32 record BE][nonce|ct|mac].
static int send_sealed(const uint8_t *plain, size_t plain_len) {
  uint8_t nonce[AGENTBUS_NONCE_BYTES];
  if (fill_random(nonce, sizeof(nonce)) != 0) return -1;
  size_t record = AB_FRAME_OVERHEAD + plain_len;
  uint8_t *out = (uint8_t *)malloc(4 + record);
  if (!out) return -1;
  uint32_t be_rec = htonl((uint32_t)record);
  memcpy(out, &be_rec, 4);
  ab_seal_frame(s_psk, AGENTBUS_AAD_MSG_CONTEXT, AGENTBUS_DIR_UP, s_epoch, s_send_seq, nonce,
                plain, plain_len, out + 4);
  int rc = send_all(out, 4 + record);
  free(out);
  if (rc == 0) s_send_seq++;
  return rc;
}

int ab_net_send(uint8_t type, uint32_t session_id, const char *payload_json) {
  if (s_sock < 0) return -1;
  size_t jlen = strlen(payload_json);
  size_t body = 1 + 4 + jlen;
  size_t total = 4 + body;
  if (s_psk_active && total > MAX_PLAIN_FRAME) return -1; // sealed record must fit RXBUF
  uint8_t *frame = (uint8_t *)malloc(total);
  if (!frame) return -1;

  uint32_t be_len = htonl((uint32_t)body);
  memcpy(frame, &be_len, 4);
  frame[4] = type;
  uint32_t be_sid = htonl(session_id);
  memcpy(frame + 5, &be_sid, 4);
  memcpy(frame + 9, payload_json, jlen);

  int rc = s_psk_active ? send_sealed(frame, total) : send_all(frame, total);
  free(frame);
  if (rc != 0) ab_net_disconnect();
  return rc;
}

int ab_net_attach(const char *token) {
  char payload[256];
  snprintf(payload, sizeof(payload), "{\"token\":\"%s\"}", token);
  return ab_net_send(AGENTBUS_MSG_ATTACH, 0, payload);
}

// Parse [u32 body][type][sid][json] frames from buf; dispatch cb for each
// complete one. Sets *consumed to the bytes of whole frames handled. Returns
// frames dispatched, or -1 on a malformed length (caller drops the connection).
static int parse_plain_frames(const uint8_t *buf, size_t len, size_t *consumed,
                              void (*cb)(const ab_frame *frame, void *ud), void *ud) {
  int dispatched = 0;
  size_t off = 0;
  while (len - off >= 4) {
    uint32_t body;
    memcpy(&body, buf + off, 4);
    body = ntohl(body);
    if (body < 5 || body > RXBUF) { // malformed/oversized: drop connection
      *consumed = off;
      return -1;
    }
    if (len - off < 4 + body) break; // wait for more bytes

    static char scratch[RXBUF];
    size_t plen = body - 5;
    ab_frame f;
    f.type = buf[off + 4];
    uint32_t sid;
    memcpy(&sid, buf + off + 5, 4);
    f.session_id = ntohl(sid);
    size_t copy = plen < sizeof(scratch) - 1 ? plen : sizeof(scratch) - 1;
    memcpy(scratch, buf + off + 9, copy);
    scratch[copy] = '\0';
    f.payload = scratch;
    f.payload_len = plen;
    if (cb) cb(&f, ud);
    dispatched++;
    off += 4 + body;
  }
  *consumed = off;
  return dispatched;
}

// Sealed stream: parse [u32 record BE][nonce|ct|mac] records from s_rx, open
// each, then run the plaintext parser on the recovered frame bytes.
static int poll_sealed(void (*cb)(const ab_frame *frame, void *ud), void *ud) {
  int dispatched = 0;
  size_t off = 0;
  while (s_rx_len - off >= 4) {
    uint32_t record;
    memcpy(&record, s_rx + off, 4);
    record = ntohl(record);
    if (record < AB_FRAME_OVERHEAD || record > RXBUF - 4) { // must fit the rx buffer
      ab_net_disconnect();
      return -1;
    }
    if (s_rx_len - off < 4 + record) break; // wait for more bytes

    static uint8_t plain[RXBUF];
    int plen = ab_open_frame(s_psk, AGENTBUS_AAD_MSG_CONTEXT, AGENTBUS_DIR_DOWN, s_epoch,
                             s_recv_seq, s_rx + off + 4, record, plain);
    if (plen < 0) { // wrong key/epoch/seq or tampering: drop connection
      ab_net_disconnect();
      return -1;
    }
    s_recv_seq++;
    size_t consumed = 0;
    int n = parse_plain_frames(plain, (size_t)plen, &consumed, cb, ud);
    if (n < 0 || consumed != (size_t)plen) { // record must hold whole frames
      ab_net_disconnect();
      return -1;
    }
    dispatched += n;
    off += 4 + record;
  }
  if (off > 0) {
    memmove(s_rx, s_rx + off, s_rx_len - off);
    s_rx_len -= off;
  }
  return dispatched;
}

int ab_net_poll(void (*cb)(const ab_frame *frame, void *ud), void *ud) {
  if (s_sock < 0) return -1;
  ssize_t n = recv(s_sock, s_rx + s_rx_len, sizeof(s_rx) - s_rx_len, 0);
  if (n == 0) { // peer closed
    ab_net_disconnect();
    return -1;
  }
  if (n < 0) {
    if (errno != EAGAIN && errno != EWOULDBLOCK) {
      ab_net_disconnect();
      return -1;
    }
  } else {
    s_rx_len += (size_t)n;
  }

  if (s_psk_active) return poll_sealed(cb, ud);

  size_t consumed = 0;
  int dispatched = parse_plain_frames(s_rx, s_rx_len, &consumed, cb, ud);
  if (dispatched < 0) {
    ab_net_disconnect();
    return -1;
  }
  if (consumed > 0) {
    memmove(s_rx, s_rx + consumed, s_rx_len - consumed);
    s_rx_len -= consumed;
  }
  return dispatched;
}
