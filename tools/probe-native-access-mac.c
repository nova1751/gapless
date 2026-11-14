// Probe a native bridge prerequisite without attaching a debugger or pausing
// playback. No memory reads/writes, remote threads, hooks, or library loading.
#include <errno.h>
#include <limits.h>
#include <libproc.h>
#include <mach/mach.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static kern_return_t probe_task(pid_t pid) {
    mach_port_t task = MACH_PORT_NULL;
    kern_return_t result = task_for_pid(mach_task_self(), pid, &task);
    if (MACH_PORT_VALID(task)) {
        mach_port_deallocate(mach_task_self(), task);
    }
    return result;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: probe-native-access-mac <NetEase main PID>\n");
        return 2;
    }
    char *end = NULL;
    errno = 0;
    long parsed = strtol(argv[1], &end, 10);
    if (errno || end == argv[1] || *end || parsed <= 0 || parsed > INT_MAX) {
        fprintf(stderr, "invalid process identifier\n");
        return 2;
    }
    pid_t pid = (pid_t)parsed;
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (proc_pidpath(pid, path, sizeof(path)) <= 0 ||
        strcmp(path, "/Applications/NeteaseMusic.app/Contents/MacOS/NeteaseMusic") != 0) {
        fprintf(stderr, "target is not the verified NetEase main executable\n");
        return 2;
    }
    kern_return_t self = probe_task(getpid());
    kern_return_t target = probe_task(pid);
    printf("{\"selfTaskResult\":%d,\"targetTaskResult\":%d,"
           "\"controlPortAvailable\":%s,\"debuggerAttached\":false,"
           "\"remoteMemoryAccessed\":false,\"processSuspended\":false}\n",
           self, target, target == KERN_SUCCESS ? "true" : "false");
    // An unavailable native bridge prerequisite is a diagnostic outcome, not
    // a request to retry with elevated privileges or change app signing.
    return self == KERN_SUCCESS ? 0 : 1;
}
