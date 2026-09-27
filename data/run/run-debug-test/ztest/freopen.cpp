#include <cstdio>
#include <iostream>
int main() {
    int x;
    if (freopen("in", "r", stdin) == nullptr) { std::cout << "NOFILE" << std::endl; return 1; }
    std::cin >> x;
    std::cout << (x * 2) << std::endl;
    return 0;
}
