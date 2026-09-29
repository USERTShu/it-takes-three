#include <iostream>
#include <map>
int p[1000];
int main() {
    int a = 1;
    int b = a + 2;
    int c = a + b;
    p[++*p]=1;
    std::map<int,int> mp;
    mp[5]=6;
    std::cout << c << std::endl;
    std::cout << mp[5] << std::endl;
    std::cout << mp[0] << "\n";
    return 0;
}
