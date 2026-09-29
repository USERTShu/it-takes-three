#include <iostream>
#include <string>
int main() {
    std::string name;
    std::cout << "hello-vp" << std::endl;
    std::getline(std::cin, name);
    std::cout << "got:" << name << std::endl;
    return 0;
}
