#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: rename-noreplace <source> <destination>\n");
    return 64;
  }

  if (syscall(SYS_renameat2, AT_FDCWD, argv[1], AT_FDCWD, argv[2],
              RENAME_NOREPLACE) == 0) {
    return 0;
  }

  fprintf(stderr, "renameat2(RENAME_NOREPLACE): %s\n", strerror(errno));
  return errno > 0 && errno < 126 ? errno : 1;
}
