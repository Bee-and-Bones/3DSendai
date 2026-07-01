// AgentBus network layer (soc:U). COMPILES; runtime UNVERIFIED without hardware.
// Frame: [u32 length BE][u8 type][u32 session_id BE][json payload].
// soc:U is initialized once; the socket can be reconnected across drops/sleeps.

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

static u32 *s_soc_buf = NULL;
static bool s_soc_ready = false;
static int s_sock = -1;
static uint8_t s_rx[RXBUF];
static size_t s_rx_len = 0;

int ab_net_init(void) {
  if (s_soc_ready) return 0;
  s_soc_buf = (u32 *)memalign(SOC_ALIGN, SOC_BUFFERSIZE);
  if (!s_soc_buf) return -1;
  if (R_FAILED(socInit(s_soc_buf, SOC_BUFFERSIZE))) return -2;
  s_soc_ready = true;
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
  return 0;
}

void ab_net_disconnect(void) {
  if (s_sock >= 0) {
    closesocket(s_sock);
    s_sock = -1;
  }
  s_rx_len = 0;
}

void ab_net_shutdown(void) {
  ab_net_disconnect();
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

int ab_net_send(uint8_t type, uint32_t session_id, const char *payload_json) {
  if (s_sock < 0) return -1;
  size_t jlen = strlen(payload_json);
  size_t body = 1 + 4 + jlen;
  size_t total = 4 + body;
  uint8_t *frame = (uint8_t *)malloc(total);
  if (!frame) return -1;

  uint32_t be_len = htonl((uint32_t)body);
  memcpy(frame, &be_len, 4);
  frame[4] = type;
  uint32_t be_sid = htonl(session_id);
  memcpy(frame + 5, &be_sid, 4);
  memcpy(frame + 9, payload_json, jlen);

  int rc = send_all(frame, total);
  free(frame);
  if (rc != 0) ab_net_disconnect();
  return rc;
}

int ab_net_attach(const char *token) {
  char payload[256];
  snprintf(payload, sizeof(payload), "{\"token\":\"%s\"}", token);
  return ab_net_send(AGENTBUS_MSG_ATTACH, 0, payload);
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

  int dispatched = 0;
  size_t off = 0;
  while (s_rx_len - off >= 4) {
    uint32_t body;
    memcpy(&body, s_rx + off, 4);
    body = ntohl(body);
    if (body < 5 || body > RXBUF) { // malformed/oversized: drop connection
      ab_net_disconnect();
      return -1;
    }
    if (s_rx_len - off < 4 + body) break; // wait for more bytes

    static char scratch[RXBUF];
    size_t plen = body - 5;
    ab_frame f;
    f.type = s_rx[off + 4];
    uint32_t sid;
    memcpy(&sid, s_rx + off + 5, 4);
    f.session_id = ntohl(sid);
    size_t copy = plen < sizeof(scratch) - 1 ? plen : sizeof(scratch) - 1;
    memcpy(scratch, s_rx + off + 9, copy);
    scratch[copy] = '\0';
    f.payload = scratch;
    f.payload_len = plen;
    if (cb) cb(&f, ud);
    dispatched++;
    off += 4 + body;
  }
  if (off > 0) {
    memmove(s_rx, s_rx + off, s_rx_len - off);
    s_rx_len -= off;
  }
  return dispatched;
}
