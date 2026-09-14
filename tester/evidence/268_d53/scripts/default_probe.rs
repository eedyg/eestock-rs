#[path = "/tmp/d53_sb/rust_probe/vectors_gen.rs"]
mod gen;
use web::dto::MultiPeriodConfigDto;
fn main() {
    let d = MultiPeriodConfigDto::default();
    println!("BACKEND_DEFAULT_DEBUG={:?}", d);
    for v in gen::vectors() {
        if v.name == "valid-single-base-default" {
            println!("VECTOR1_INPUT_DEBUG={:?}", v.cfg);
        }
    }
}
