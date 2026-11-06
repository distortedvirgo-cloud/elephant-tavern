// Starts the embedded Node.js runtime (nodejs-mobile) and pipes its
// stdout/stderr into logcat under the "ElephantNode" tag.
#include <jni.h>
#include <android/log.h>
#include <pthread.h>
#include <unistd.h>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "node.h"

namespace {

int g_pipe[2];
const char *kTag = "ElephantNode";

void *LogThread(void *) {
    char buf[2048];
    std::string line;
    ssize_t n;
    while ((n = read(g_pipe[0], buf, sizeof(buf))) > 0) {
        line.append(buf, static_cast<size_t>(n));
        size_t pos;
        while ((pos = line.find('\n')) != std::string::npos) {
            __android_log_write(ANDROID_LOG_INFO, kTag, line.substr(0, pos).c_str());
            line.erase(0, pos + 1);
        }
    }
    return nullptr;
}

void RedirectOutput() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    if (pipe(g_pipe) != 0) return;
    dup2(g_pipe[1], STDOUT_FILENO);
    dup2(g_pipe[1], STDERR_FILENO);
    pthread_t thread;
    if (pthread_create(&thread, nullptr, LogThread, nullptr) == 0) {
        pthread_detach(thread);
    }
}

std::string ToString(JNIEnv *env, jstring s) {
    const char *chars = env->GetStringUTFChars(s, nullptr);
    std::string out(chars);
    env->ReleaseStringUTFChars(s, chars);
    return out;
}

}  // namespace

// Blocks until node exits. Must be called on a dedicated thread, once per process.
extern "C" JNIEXPORT jint JNICALL
Java_com_elephanttavern_app_NodeBridge_startNode(JNIEnv *env, jclass, jobjectArray jargs, jobjectArray jenv) {
    // Environment first: several variables are read only during bootstrap.
    const jsize envCount = env->GetArrayLength(jenv);
    for (jsize i = 0; i + 1 < envCount; i += 2) {
        auto key = ToString(env, static_cast<jstring>(env->GetObjectArrayElement(jenv, i)));
        auto value = ToString(env, static_cast<jstring>(env->GetObjectArrayElement(jenv, i + 1)));
        setenv(key.c_str(), value.c_str(), 1);
    }

    // node::Start expects argv strings to live in one contiguous buffer.
    const jsize argc = env->GetArrayLength(jargs);
    std::vector<std::string> args;
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        args.push_back(ToString(env, static_cast<jstring>(env->GetObjectArrayElement(jargs, i))));
        total += args.back().size() + 1;
    }
    char *buffer = static_cast<char *>(calloc(total, 1));
    std::vector<char *> argv(static_cast<size_t>(argc) + 1, nullptr);
    char *cursor = buffer;
    for (jsize i = 0; i < argc; i++) {
        memcpy(cursor, args[i].c_str(), args[i].size());
        argv[i] = cursor;
        cursor += args[i].size() + 1;
    }

    RedirectOutput();
    int code = node::Start(static_cast<int>(argc), argv.data());
    __android_log_print(ANDROID_LOG_WARN, kTag, "node exited with code %d", code);
    return code;
}
