cmake_minimum_required(VERSION 3.22.1)
project(elephantnode CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Downloaded by scripts/fetch-libnode.sh (nodejs-mobile release zip).
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES IMPORTED_LOCATION ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

add_library(native-lib SHARED native-lib.cpp)
target_include_directories(native-lib PRIVATE ${LIBNODE_DIR}/include/node)
target_link_options(native-lib PRIVATE "-Wl,-z,max-page-size=16384")

find_library(log-lib log)
target_link_libraries(native-lib libnode ${log-lib})
