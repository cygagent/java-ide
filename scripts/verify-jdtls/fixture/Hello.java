import java.util.ArrayList;
import java.util.List;

/**
 * JDT LS 前置验证用最小 Java 源文件。
 * 注意：文件本身是完整可编译的，验证脚本会在 String 类型的 `text.` 之后触发补全，
 * 因此不要改动下方 demo() 中 text.length() 的写法。
 */
public class Hello {

    public static void main(String[] args) {
        List<String> list = new ArrayList<>();
        list.add("alpha");
        list.add("beta");
        System.out.println(list.size());
    }

    public static void demo() {
        String text = "hello";
        text.length();
    }
}
